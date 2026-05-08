import { NextRequest, NextResponse } from 'next/server';
import { OpenRouter } from '@openrouter/sdk';
import { db } from '@/db';
import { sql, eq } from 'drizzle-orm';
import { fetchFromMedexByQuery } from '@/lib/medex-scraper';
import { externalMedicine } from '@/db/schema';
import crypto from 'crypto';
import sharp from 'sharp';

const openRouter = new OpenRouter({
    apiKey: process.env.OPENROUTER_API_KEY,
    httpReferer: 'https://hellomed.com',
    appTitle: 'HelloMed: Simplified healthcare in your pocket',
});

export const maxDuration = 60; // Set max duration for Vercel/Next API execution

export async function POST(request: NextRequest) {
    const totalPipelineStart = Date.now();
    let debugInfo: any = {
        step0_image_processing_ms: 0,
        step1_vision_model_ms: 0,
        step2_total_db_scraper_ms: 0,
        step2_breakdown: [],
        step3_llm_judge_ms: 0,
        step4_geolocation_db_ms: 0,
        total_pipeline_ms: 0,
        step1_raw_ocr_output: [] as { medicineName: string, dosage: string }[],
        step2_database_hits: [] as any[],
    };

    try {
        const { image } = await request.json(); // base64 string

        if (!image) {
            return NextResponse.json({ success: false, error: 'No image provided' }, { status: 400 });
        }

        // ==========================================
        // STEP 0: Image Pre-Processing
        // Binarize and sharpen to clarify ambiguous loops (like '৪' vs '8')
        // ==========================================
        const step0Start = Date.now();
        let processedImageBase64 = image;
        try {
            const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
            const imageBuffer = Buffer.from(base64Data, 'base64');
            const processedBuffer = await sharp(imageBuffer)
                .greyscale()
                .normalize()
                .toBuffer();
            
            const mimeType = image.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg';
            processedImageBase64 = `data:${mimeType};base64,${processedBuffer.toString('base64')}`;
        } catch (e) {
            console.error('[OCR] Image pre-processing failed, using original', e);
        }
        debugInfo.step0_image_processing_ms = Date.now() - step0Start;
        console.log(`[OCR] Step 0 completed in ${debugInfo.step0_image_processing_ms}ms`);

        // ==========================================
        // STEP 1: The "Sniper" Vision Model
        // Extract raw text from messy handwriting using Qwen 2.5 VL
        // ==========================================
        const step1Start = Date.now();
        console.log('[OCR] Starting Step 1: Vision Model');

        const visionCompletion = await openRouter.chat.send({
            chatRequest: {
                model: 'qwen/qwen2.5-vl-72b-instruct',
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: 'You are an expert Bangladeshi pharmacist. Read this messy prescription exactly as written. Extract the actual medicines and their dosage instructions. Note: Bangladeshi prescriptions often mix English and Bengali. Be very careful with numbers: Bengali "৪" (4) is often misread as English "8", and "১" (1) or "২" (2) can be tricky. Pay close attention to dosage patterns (e.g., 1+0+1, 0+0+1) and avoid misreading them (e.g., as 2+0+2). ONLY output a JSON array of objects. No Markdown wrappers. Example: [{"medicineName": "Cef-3 250mg", "dosage": "1+0+1 for 7 days"}]' },
                            { type: 'image_url', imageUrl: { url: processedImageBase64 } },
                        ],
                    },
                ],
                stream: false,
            }
        });

        debugInfo.step1_vision_model_ms = Date.now() - step1Start;
        console.log(`[OCR] Step 1 completed in ${debugInfo.step1_vision_model_ms}ms`);
        const rawVisionText = visionCompletion.choices[0]?.message?.content?.trim() || "[]";

        let rawOcrArray: { medicineName: string, dosage: string }[] = [];
        try {
            // Remove any markdown wrappers if the model still returns them (e.g., ```json ... ```)
            const cleanJsonText = rawVisionText.replace(/```json/g, '').replace(/```/g, '').trim();
            rawOcrArray = JSON.parse(cleanJsonText);
        } catch (e) {
            console.error('[OCR] Failed to parse vision JSON:', rawVisionText, e);
            return NextResponse.json({ success: false, error: 'Failed to extract text from prescription.' }, { status: 500 });
        }

        debugInfo.step1_raw_ocr_output = rawOcrArray;

        if (rawOcrArray.length === 0) {
            return NextResponse.json({
                success: true,
                debug: debugInfo,
                final_data: []
            });
        }

        // ==========================================
        // STEP 2: The Database Intercept
        // Use pg_trgm fuzzy matching to find potential database fits
        // ==========================================
        const step2Start = Date.now();
        console.log('[OCR] Starting Step 2: DB Trigram Search');

        // Parallelize database queries using Promise.all
        const dbHits = await Promise.all(
            rawOcrArray.map(async (item) => {
                const queryText = item.medicineName || '';
                
                // Strip common prefixes (Tab, Cap, Syr, etc.) to vastly improve search hits on Medex/DB
                const cleanName = queryText.replace(/^(tab|cap|syr|syp|inj|drop|drops|susp|lotion|cream|ointment|supp|sol|soln)s?\b[\.\-\s]+/i, '').trim();

                // Ignore very short strings
                if (cleanName.length < 3) return null;

                const searchTerm = cleanName.toLowerCase();
                const itemBreakdown = { query: queryText, primary_ms: 0, secondary_ms: 0, scraper_ms: 0, total_ms: 0 };
                const itemStart = Date.now();

                try {
                    let primarySuccess = false;

                    const primarySearchPromise = (async () => {
                        const t0 = Date.now();
                        console.log(`[OCR] Primary DB Search started for "${queryText}"`);
                        const results = await db.execute(sql`
                            SELECT DISTINCT
                                m.brand_name,
                                g.name as generic_name,
                                GREATEST(
                                    similarity(LOWER(m.brand_name), ${searchTerm}),
                                    similarity(LOWER(g.name), ${searchTerm})
                                ) as sim_score
                            FROM medicines m
                            LEFT JOIN generics g ON m.generic_id = g.id
                            WHERE 
                                LOWER(m.brand_name) % ${searchTerm} OR LOWER(g.name) % ${searchTerm}
                            ORDER BY sim_score DESC
                            LIMIT 3
                        `);

                        if (results.rows.length > 0 && parseFloat((results.rows[0].sim_score as number).toFixed(2)) >= 0.4) {
                            primarySuccess = true;
                            itemBreakdown.primary_ms = Date.now() - t0;
                            console.log(`[OCR] Primary DB Hit for "${queryText}": ${results.rows[0].brand_name} (Score: ${parseFloat((results.rows[0].sim_score as number).toFixed(2))})`);
                            return {
                                query: queryText,
                                matches: results.rows.map(r => ({
                                    name: r.brand_name as string,
                                    generic: r.generic_name as string || null,
                                    score: parseFloat((r.sim_score as number).toFixed(2)),
                                    source: 'HelloMed Primary'
                                }))
                            };
                        }
                        itemBreakdown.primary_ms = Date.now() - t0;
                        console.log(`[OCR] Primary DB Miss for "${queryText}"`);
                        return null;
                    })();

                    const secondarySearchPromise = (async () => {
                        const t0 = Date.now();
                        // Start secondary search 150ms later
                        await new Promise(resolve => setTimeout(resolve, 150));
                        
                        // Abort if primary already succeeded
                        if (primarySuccess) {
                            itemBreakdown.secondary_ms = Date.now() - t0;
                            console.log(`[OCR] Secondary DB Search aborted for "${queryText}" (Primary already succeeded)`);
                            return null;
                        }

                        console.log(`[OCR] Secondary DB Search started for "${queryText}"`);

                        // Search in external_medicines (secondary database)
                        const externalResults = await db.execute(sql`
                            SELECT DISTINCT
                                brand_name,
                                generic_name,
                                GREATEST(
                                    similarity(LOWER(brand_name), ${searchTerm}),
                                    similarity(LOWER(COALESCE(generic_name, '')), ${searchTerm})
                                ) as sim_score
                            FROM external_medicines
                            WHERE 
                                LOWER(brand_name) % ${searchTerm} OR LOWER(COALESCE(generic_name, '')) % ${searchTerm}
                            ORDER BY sim_score DESC
                            LIMIT 3
                        `);

                        if (externalResults.rows.length > 0 && parseFloat((externalResults.rows[0].sim_score as number).toFixed(2)) >= 0.4) {
                            itemBreakdown.secondary_ms = Date.now() - t0;
                            console.log(`[OCR] Secondary DB Hit for "${queryText}": ${externalResults.rows[0].brand_name} (Score: ${parseFloat((externalResults.rows[0].sim_score as number).toFixed(2))})`);
                            return {
                                query: queryText,
                                matches: externalResults.rows.map(r => ({
                                    name: r.brand_name as string,
                                    generic: r.generic_name as string || null,
                                    score: parseFloat((r.sim_score as number).toFixed(2)),
                                    source: 'HelloMed Secondary'
                                }))
                            };
                        }
                        console.log(`[OCR] Secondary DB Miss for "${queryText}"`);

                        // Abort scraping if primary succeeded in the meantime
                        if (primarySuccess) {
                            itemBreakdown.secondary_ms = Date.now() - t0;
                            return null;
                        }

                        // Fallback to Medex Scraper if no strong match in either DB
                        console.log(`[OCR] Falling back to Medex Scraper for "${queryText}"...`);
                        const tScrape = Date.now();
                        const medexItem = await fetchFromMedexByQuery(searchTerm);
                        itemBreakdown.scraper_ms = Date.now() - tScrape;

                        if (medexItem && medexItem.brandName) {
                            console.log(`[OCR] Medex Scraper Hit for "${queryText}": ${medexItem.brandName}`);
                            // Check if we already cached this in externalMedicine
                            const existing = await db.select().from(externalMedicine).where(eq(externalMedicine.brandName, medexItem.brandName)).limit(1);
                            
                            if (existing.length === 0) {
                                console.log(`[OCR] Saving scraped item "${medexItem.brandName}" to secondary database (external_medicines).`);
                                await db.insert(externalMedicine).values({
                                    id: crypto.randomUUID(),
                                    brandName: medexItem.brandName,
                                    genericName: medexItem.genericName,
                                    strength: medexItem.strength,
                                    manufacturer: medexItem.manufacturer,
                                    dosageForm: medexItem.dosageForm,
                                    price: medexItem.price,
                                    packageContainer: medexItem.packageContainer,
                                    packageSize: medexItem.packageSize,
                                    indicationDescription: medexItem.indicationDescription,
                                    dosageDescription: medexItem.dosageDescription,
                                    sourceUrl: medexItem.sourceUrl,
                                });
                            }
                            
                            itemBreakdown.secondary_ms = Date.now() - t0;
                            return {
                                query: queryText,
                                matches: [{
                                    name: medexItem.brandName,
                                    generic: medexItem.genericName || "Unknown",
                                    score: 1.00, // Scraped data is considered a top hit
                                    source: 'HelloMed Secondary'
                                }]
                            };
                        }
                        itemBreakdown.secondary_ms = Date.now() - t0;
                        console.log(`[OCR] Medex Scraper Miss for "${queryText}"`);
                        return null;
                    })();

                    const [primaryResult, secondaryResult] = await Promise.all([primarySearchPromise, secondarySearchPromise]);
                    
                    itemBreakdown.total_ms = Date.now() - itemStart;
                    debugInfo.step2_breakdown.push(itemBreakdown);

                    if (primaryResult) return primaryResult;
                    if (secondaryResult) return secondaryResult;

                } catch (err) {
                    console.error(`[OCR] DB/Scraper error on query "${queryText}":`, err);
                    itemBreakdown.total_ms = Date.now() - itemStart;
                    debugInfo.step2_breakdown.push(itemBreakdown);
                }
                return null;
            })
        ).then(results => results.filter((hit): hit is NonNullable<typeof hit> => hit !== null));

        debugInfo.step2_database_hits = dbHits;
        debugInfo.step2_total_db_scraper_ms = Date.now() - step2Start;
        console.log(`[OCR] Step 2 completed in ${debugInfo.step2_total_db_scraper_ms}ms`);

        // If nothing matched in DB, return empty rather than hallucinative names
        // But let DeepSeek judge it first.

        // ==========================================
        // STEP 3: The LLM Judge
        // Perfect the DB matches using DeepSeek-v3
        // ==========================================
        const step3Start = Date.now();
        console.log('[OCR] Starting Step 3: LLM Judge');

        const promptText = `
You are a brilliant Bangladeshi pharmacist.
I will give you the structured JSON extracted from a messy prescription picture (containing medicineName and dosage), AND a list of potential database matches found via fuzzy search for those medicines.

Your job is to deduce the REAL intended medicine names by linking the raw 'medicineName' to the correct Database options.
You must discard irrelevant database hits (e.g. if the DB hit "Cefur" but the raw text clearly said "Cef 3", output "Cef-3 250mg" if that was a DB option).

CRITICAL DOSAGE FIX: The vision model often misreads the Bengali digit '৪' (4) as an English '8' or the letter 'B' due to messy handwriting loops. If you see an illogical '8' or 'B' in the raw dosage instruction (e.g., 'B+0+B', '0+0+8', 'apply 8 times a day'), mathematically and logically correct it to '4' or '৪' in your final output. Otherwise, preserve the dosage exactly as found.

RAW OCR EXTRACT (with dosages):
${JSON.stringify(rawOcrArray, null, 2)}

DATABASE HITS FROM FUZZY SEARCH (for the medicineNames):
${JSON.stringify(dbHits, null, 2)}

Strictly return ONLY a JSON array of objects mapping the final deduced name, generic, the preserved dosage, the source of the data from the hit, and a short reasoning explaining why you chose this match.
Example format:
[
  { "name": "Cef-3 250mg", "generic": "Cefixime", "dosage": "1+0+1 for 7 days", "source": "HelloMed DB", "reasoning": "Raw input matched 'Cef-3 250mg' in database" },
  { "name": "Napa Extend 665mg", "generic": "Paracetamol", "dosage": "if fever", "source": "Medex API", "reasoning": "Deduced from raw input 'Napa ext' and matched with 'Napa Extend 665mg'" }
]
No Markdown blocks, no explanations. ONLY pure JSON array.
        `;

        const judgeCompletion = await openRouter.chat.send({
            chatRequest: {
                model: 'deepseek/deepseek-chat',
                messages: [
                    { role: 'user', content: promptText }
                ],
                stream: false,
            }
        });

        debugInfo.step3_llm_judge_ms = Date.now() - step3Start;
        console.log(`[OCR] Step 3 completed in ${debugInfo.step3_llm_judge_ms}ms`);
        const rawJudgeOutput = judgeCompletion.choices[0]?.message?.content?.trim() || "[]";

        let finalData = [];
        try {
            let cleanFinalJson = rawJudgeOutput;
            const jsonMatch = rawJudgeOutput.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
            if (jsonMatch) {
                cleanFinalJson = jsonMatch[1].trim();
            } else {
                cleanFinalJson = rawJudgeOutput.trim();
                const firstBracket = cleanFinalJson.indexOf('[');
                const lastBracket = cleanFinalJson.lastIndexOf(']');
                if (firstBracket !== -1 && lastBracket !== -1) {
                    cleanFinalJson = cleanFinalJson.substring(firstBracket, lastBracket + 1);
                }
            }
            finalData = JSON.parse(cleanFinalJson);
        } catch (e) {
            console.error('[OCR] Failed to parse judge JSON:', rawJudgeOutput, e);
            // Fallback: If judge failed to return clean JSON, we just return the top hit from each DB query
            finalData = dbHits.map(hit => ({
                name: hit.matches[0]?.name || "Unknown",
                generic: hit.matches[0]?.generic || null,
                dosage: rawOcrArray.find(o => o.medicineName === hit.query)?.dosage || "",
                source: hit.matches[0]?.source || "Unknown",
                reasoning: "Matched highest scoring database hit (AI failed to parse reasoning)"
            }));
        }

        console.log('[OCR] Pipeline steps 1-3 complete. Moving to Step 4.');

        // ==========================================
        // STEP 4: Geolocation and Anonymized Tracking
        // ==========================================
        try {
            // Capture IP Address
            let ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || request.ip || '127.0.0.1';
            // Clean up if it's a comma separated list
            if (ip.includes(',')) {
                ip = ip.split(',')[0].trim();
            }

            // Mock Dhaka IP for local testing
            if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') {
                ip = '103.112.54.1'; // An IP from Dhaka, Bangladesh
            }

            let geo: any = null;
            try {
                // Using ip-api to avoid geoip-lite local file read issues in Next.js
                const res = await fetch(`http://ip-api.com/json/${ip}`);
                if (res.ok) {
                    geo = await res.json();
                }
            } catch (geoError) {
                console.error('[OCR] Failed to lookup IP:', geoError);
            }

            // Fire and forget insertion into scan_records
            if (finalData.length > 0) {
                const insertPromises = finalData.map(async (item: any) => {
                    await db.insert(require('@/db/schema').scanRecord).values({
                        id: crypto.randomUUID(),
                        medicineName: item.name,
                        genericName: item.generic || null,
                        source: item.source || "Unknown",
                        approxLat: geo?.lat ? String(geo.lat) : null,
                        approxLng: geo?.lon ? String(geo.lon) : null,
                        city: geo?.city || null,
                        region: geo?.regionName || null,
                        country: geo?.country || null,
                    });
                });
                // We do not await this so we don't block the response
                Promise.all(insertPromises).catch(err => console.error('[OCR] Failed to log scan_records:', err));
            }
        } catch (geoError) {
            console.error('[OCR] Geolocation tracking error:', geoError);
        }
        
        debugInfo.step4_geolocation_db_ms = Date.now() - (step3Start + debugInfo.step3_llm_judge_ms); // Approx start of step 4
        debugInfo.total_pipeline_ms = Date.now() - totalPipelineStart;
        console.log(`[OCR] Full Pipeline Complete in ${debugInfo.total_pipeline_ms}ms`);

        return NextResponse.json({
            success: true,
            debug: debugInfo,
            final_data: finalData
        });

    } catch (error: any) {
        console.error('[OCR] Main Pipeline Error:', error);
        return NextResponse.json({
            success: false,
            error: error.message || 'Internal server error during OCR processing.'
        }, { status: 500 });
    }
}