import * as cheerio from 'cheerio';
import crypto from 'crypto';

export interface ExternalMedicineData {
    brandName: string;
    genericName: string | null;
    strength: string | null;
    manufacturer: string | null;
    dosageForm: string | null;
    price: string | null;
    packageContainer: string | null;
    packageSize: string | null;
    indicationDescription: string | null;
    dosageDescription: string | null;
    sourceUrl: string;
}

export interface AlternateBrand {
    brandName: string;
    manufacturer: string;
    strength: string;
    dosageForm: string;
    price: string;
    url: string;
}

const MEDEX_BASE_URL = 'https://medex.com.bd';

/**
 * Searches medex and returns the first matching medicine URL if found.
 */
export async function searchMedexFirstLink(query: string): Promise<string | null> {
    try {
        const queryTerm = encodeURIComponent(query).replace(/%20/g, '+');
        const searchUrl = `${MEDEX_BASE_URL}/ajax/search?searchtype=search&searchkey=${queryTerm}`;
        
        const response = await fetch(searchUrl, {
            headers: {
                'Accept': 'text/html',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'X-Requested-With': 'XMLHttpRequest'
            }
        });

        if (!response.ok) return null;
        
        const html = await response.text();
        const $ = cheerio.load(html);
        
        // Find the first anchor link
        const firstLink = $('a').first().attr('href');
        return firstLink || null;
    } catch (e) {
        console.error('[MedexScraper] Search Error:', e);
        return null;
    }
}

/**
 * Scrapes medicine details from a Medex medicine page URL.
 */
export async function scrapeMedicineDetails(url: string): Promise<ExternalMedicineData | null> {
    try {
        // Prevent recursive generic brand searches if they link wrongly
        if (!url.includes('/brands/')) return null;

        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0'
            }
        });
        
        if (!response.ok) return null;
        const html = await response.text();
        const $ = cheerio.load(html);

        // e.g. "Vivori"
        const brandName = $('h1.page-heading-1-l').text().trim() || null;
        if (!brandName) return null;

        // Extract strength and dosage form from title (usually follows the brand name)
        // e.g., "Vivori | 50 mg | Tablet" -> "50 mg", "Tablet"
        const titleText = $('title').text().trim();
        const titleParts = titleText.split('|');
        const strength = titleParts.length > 1 ? titleParts[1].trim() : null;
        const dosageForm = titleParts.length > 2 ? titleParts[2].split('|')[0].trim() : null;

        const genericName = $('.generic-name a').text().trim() || null;
        const manufacturer = $('.manufac-name a').text().trim() || null;
        
        // Price and Package: usually within div class "package-pricing"
        let price = null;
        let packageContainer = null;
        let packageSize = null;
        const pricingText = $('.package-pricing').text().trim();
        if (pricingText) {
            price = pricingText; // E.g. "Unit Price: ৳ 5.00 (30's pack: ৳ 150.00)"
        }

        // Descriptions usually found under headers id="indications" and id="dosage"
        const indicationDescription = $('#indications').nextUntil('h4').text().trim() || null;
        const dosageDescription = $('#dosage').nextUntil('h4').text().trim() || null;

        return {
            brandName,
            genericName,
            strength,
            manufacturer,
            dosageForm,
            price,
            packageContainer,
            packageSize,
            indicationDescription,
            dosageDescription,
            sourceUrl: url
        };
    } catch (e) {
        console.error('[MedexScraper] Scrape Error:', e);
        return null;
    }
}

/**
 * Main easy method to quickly do a search + extract if we don't have it locally.
 */
export async function fetchFromMedexByQuery(query: string): Promise<ExternalMedicineData | null> {
    const link = await searchMedexFirstLink(query);
    if (!link) return null;
    return await scrapeMedicineDetails(link);
}
