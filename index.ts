import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { OpenRouter } from '@openrouter/sdk';
import { db } from './db';
import { sql, eq } from 'drizzle-orm';
import { fetchFromMedexByQuery } from './lib/medex-scraper';
import { externalMedicine, scanRecord } from './db/schema';
import crypto from 'crypto';
import sharp from 'sharp';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(cors()); // Allow cross-origin requests from the frontend
app.use(express.json({ limit: '10mb' })); // Increase JSON limit for base64 images

const openRouter = new OpenRouter({
    apiKey: process.env.OPENROUTER_API_KEY,
    httpReferer: 'https://hellomed.com',
    appTitle: 'HelloMed: Simplified healthcare in your pocket',
});

// A simple ping route to keep Render awake if needed
app.get('/ping', (req, res) => {
    res.json({ status: 'awake', timestamp: new Date().toISOString() });
});

// Main OCR route
app.post('/api/ocr', async (req, res) => {
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
        const { image } = req.body; // base64 string

        if (!image) {
            return res.status(400).json({ success: false, error: 'No image provided' });
        }

        // ==========================================
        // STEP 0: Image Pre-Processing
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
            const cleanJsonText = rawVisionText.replace(/```json/g, '').replace(/```/g, '').trim();
            rawOcrArray = JSON.parse(cleanJsonText);
        } catch (e) {
            console.error('[OCR] Failed to parse vision JSON:', rawVisionText, e);
            return res.status(500).json({ success: false, error: 'Failed to extract text from prescription.' });
        }

        debugInfo.step1_raw_ocr_output = rawOcrArray;

        if (rawOcrArray.length === 0) {
            return res.json({
                success: true,
                debug: debugInfo,
                final_data: []
            });
        }

        // ==========================================
        // STEP 2: The Database Intercept
        // ==========================================
        const step2Start = Date.now();
        console.log('[OCR] Starting Step 2: DB Trigram Search');

        const dbHits = await Promise.all(
            rawOcrArray.map(async (item) => {
                const queryText = item.medicineName || '';
                
                const cleanName = queryText.replace(/^(tab|cap|syr|syp|inj|drop|drops|susp|lotion|cream|ointment|supp|sol|soln)s?\b[\.\-\s]+/i, '').trim();

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
                        await new Promise(resolve => setTimeout(resolve, 150));
                        
                        if (primarySuccess) {
                            itemBreakdown.secondary_ms = Date.now() - t0;
                            return null;
                        }

                        console.log(`[OCR] Secondary DB Search started for "${queryText}"`);

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
                            console.log(`[OCR] Secondary DB Hit for "${queryText}": ${externalResults.rows[0].brand_name}`);
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

                        if (primarySuccess) {
                            itemBreakdown.secondary_ms = Date.now() - t0;
                            return null;
                        }

                        console.log(`[OCR] Falling back to Medex Scraper for "${queryText}"...`);
                        const tScrape = Date.now();
                        const medexItem = await fetchFromMedexByQuery(searchTerm);
                        itemBreakdown.scraper_ms = Date.now() - tScrape;

                        if (medexItem && medexItem.brandName) {
                            console.log(`[OCR] Medex Scraper Hit for "${queryText}": ${medexItem.brandName}`);
                            const existing = await db.select().from(externalMedicine).where(eq(externalMedicine.brandName, medexItem.brandName)).limit(1);
                            
                            if (existing.length === 0) {
                                console.log(`[OCR] Saving scraped item "${medexItem.brandName}" to secondary database.`);
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
                                    score: 1.00,
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
        ).then((results: any) => results.filter((hit: any) => hit !== null));

        debugInfo.step2_database_hits = dbHits;
        debugInfo.step2_total_db_scraper_ms = Date.now() - step2Start;
        console.log(`[OCR] Step 2 completed in ${debugInfo.step2_total_db_scraper_ms}ms`);

        // ==========================================
        // STEP 3: The LLM Judge
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

        let finalData: any = [];
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
            finalData = dbHits.map((hit: any) => ({
                name: hit.matches[0]?.name || "Unknown",
                generic: hit.matches[0]?.generic || null,
                dosage: rawOcrArray.find((o: any) => o.medicineName === hit.query)?.dosage || "",
                source: hit.matches[0]?.source || "Unknown",
                reasoning: "Matched highest scoring database hit (AI failed to parse reasoning)"
            }));
        }

        console.log('[OCR] Pipeline steps 1-3 complete. Moving to Step 4.');

        // ==========================================
        // STEP 4: Geolocation and Anonymized Tracking
        // ==========================================
        try {
            let ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.ip || '127.0.0.1';
            if (typeof ip === 'string' && ip.includes(',')) {
                ip = ip.split(',')[0].trim();
            } else if (Array.isArray(ip)) {
                ip = ip[0].trim();
            }

            if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') {
                ip = '103.112.54.1'; // Dhaka IP
            }

            let geo: any = null;
            try {
                const res = await fetch(`http://ip-api.com/json/${ip}`);
                if (res.ok) {
                    geo = await res.json();
                }
            } catch (geoError) {
                console.error('[OCR] Failed to lookup IP:', geoError);
            }

            if (finalData.length > 0) {
                const insertPromises = finalData.map(async (item: any) => {
                    await db.insert(scanRecord).values({
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
                Promise.all(insertPromises).catch(err => console.error('[OCR] Failed to log scan_records:', err));
            }
        } catch (geoError) {
            console.error('[OCR] Geolocation tracking error:', geoError);
        }
        
        debugInfo.step4_geolocation_db_ms = Date.now() - (step3Start + debugInfo.step3_llm_judge_ms);
        debugInfo.total_pipeline_ms = Date.now() - totalPipelineStart;
        console.log(`[OCR] Full Pipeline Complete in ${debugInfo.total_pipeline_ms}ms`);

        return res.json({
            success: true,
            debug: debugInfo,
            final_data: finalData
        });

    } catch (error: any) {
        console.error('[OCR] Main Pipeline Error:', error);
        return res.status(500).json({
            success: false,
            error: error.message || 'Internal server error during OCR processing.'
        });
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Offload OCR worker is running on port ${PORT}`);
});
