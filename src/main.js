// Goodreads Review Scraper - Playwright Chrome implementation
import { Actor, log } from 'apify';
import { PlaywrightCrawler, Dataset } from 'crawlee';

await Actor.init();

const input = (await Actor.getInput()) || {};
const {
    start_url: START_URL = 'https://www.goodreads.com/book/show/2767052-the-catcher-in-the-rye/reviews',
    results_wanted: RESULTS_WANTED_RAW = 20,
    maxConcurrency = 2,
    debugLog = false,
    startUrls,
    proxyConfiguration: proxyConfig,
} = input;

if (debugLog) {
    log.setLevel(log.LEVELS.DEBUG);
}

const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW) ? Math.max(1, +RESULTS_WANTED_RAW) : 20;

const proxyConfiguration = await Actor.createProxyConfiguration(proxyConfig || {
    useApifyProxy: true,
    apifyProxyGroups: ['RESIDENTIAL'],
});

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxRequestRetries: 3,
    useSessionPool: true,
    sessionPoolOptions: {
        maxPoolSize: 5,
        sessionOptions: { maxUsageCount: 5 },
    },
    maxConcurrency,
    requestHandlerTimeoutSecs: 180, // Extended for "Load More" loops
    navigationTimeoutSecs: 60,

    // Stealth Configuration
    browserPoolOptions: {
        useFingerprints: true,
        fingerprintOptions: {
            fingerprintGeneratorOptions: {
                browsers: ['chrome'],
                devices: ['desktop'],
                locales: ['en-US'],
            },
        },
    },

    preNavigationHooks: [
        async ({ page }) => {
            // Block heavy resources
            await page.route('**/*', (route) => {
                const type = route.request().resourceType();
                const url = route.request().url();
                if (['image', 'font', 'media'].includes(type) ||
                    url.includes('google-analytics') ||
                    url.includes('googletagmanager')) {
                    return route.abort();
                }
                return route.continue();
            });

            // Hide webdriver
            await page.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
            });
        },
    ],

    async requestHandler({ page, request }) {
        log.info(`Processing: ${request.url}`);

        await page.waitForLoadState('domcontentloaded');

        // Close any "SignIn" modal if it appears (common on Goodreads)
        try {
            const closeBtn = page.locator('[aria-label="Close"]');
            if (await closeBtn.isVisible({ timeout: 2000 })) {
                await closeBtn.click();
            }
        } catch { }

        let savedCount = 0;
        const seenIds = new Set();
        let loopCount = 0;
        const MAX_LOOPS = 50; // Safety break

        while (savedCount < RESULTS_WANTED && loopCount < MAX_LOOPS) {
            loopCount++;
            log.info(`Scraping loop ${loopCount}, saved so far: ${savedCount}`);

            // Hybrid Extraction Strategy
            const reviews = await page.evaluate(() => {
                const extracted = [];

                // 1. Try __NEXT_DATA__ (Apollo State)
                try {
                    const nextDataScript = document.getElementById('__NEXT_DATA__');
                    if (nextDataScript) {
                        const json = JSON.parse(nextDataScript.innerText);
                        const apolloState = json.props?.pageProps?.apolloState || {};

                        Object.entries(apolloState).forEach(([key, val]) => {
                            if (key.startsWith('Review:')) {
                                extracted.push({
                                    id: key,
                                    reviewerName: val.creator?.name,
                                    rating: val.rating,
                                    date: val.createdAt, // Or similar field
                                    text: val.text, // Often full text
                                    url: val.webUrl,
                                    source: 'apollo'
                                });
                            }
                        });
                    }
                } catch (e) {
                    // console.error('NextData parse error', e);
                }

                // 2. Fallback/Supplement with DOM
                const reviewCards = document.querySelectorAll('article.ReviewCard');
                reviewCards.forEach((card, idx) => {
                    const name = card.querySelector('[data-testid="name"], .ReviewerProfile__name')?.innerText;
                    const ratingLabel = card.querySelector('.RatingStars')?.getAttribute('aria-label'); // "Rating 4 out of 5"
                    const ratingMatch = ratingLabel?.match(/Rating (\d+) out of 5/);
                    const rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;
                    const date = card.querySelector('.ReviewCard__content a[href*="/review/show"]')?.innerText;

                    // Prioritize full text if available
                    let text = card.querySelector('.ReviewText__content--full')?.innerText;
                    if (!text) {
                        text = card.querySelector('.ReviewText__content')?.innerText;
                    }

                    const url = card.querySelector('.ReviewCard__content a[href*="/review/show"]')?.href;
                    const id = url || `dom-review-${idx}`;

                    if (name) {
                        extracted.push({
                            id,
                            reviewerName: name,
                            rating,
                            date,
                            text,
                            url,
                            source: 'dom'
                        });
                    }
                });

                return extracted;
            });

            // Process new reviews
            const newReviews = [];
            for (const r of reviews) {
                if (!seenIds.has(r.id)) {
                    seenIds.add(r.id);
                    // Normalize
                    newReviews.push({
                        reviewer_name: r.reviewerName,
                        rating: r.rating,
                        date: r.date,
                        review_text: r.text,
                        review_url: r.url,
                        book_url: request.url
                    });
                }
            }

            if (newReviews.length > 0) {
                const remaining = RESULTS_WANTED - savedCount;
                const toSave = newReviews.slice(0, remaining);
                await Dataset.pushData(toSave);
                savedCount += toSave.length;
                log.info(`Extracted ${toSave.length} new reviews.`);
            }

            if (savedCount >= RESULTS_WANTED) break;

            // Pagination: Click "Show more reviews"
            try {
                // Selector for the "Show more reviews" button. 
                // Often: span.Button__labelItem equal to "Show more reviews"
                const loadMoreBtn = page.locator('button:has-text("Show more reviews"), button[class*="Button"]:has-text("Show more")').first();

                if (await loadMoreBtn.isVisible()) {
                    log.info('Clicking "Show more reviews"...');
                    await loadMoreBtn.scrollIntoViewIfNeeded();
                    await loadMoreBtn.click();

                    // Wait for new content. 
                    // Strategy: Wait for network idle or a short delay if network is tricky
                    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => Promise.resolve());
                    await page.waitForTimeout(2000); // Specific human delay
                } else {
                    log.info('No more "Show more reviews" button found.');
                    break;
                }
            } catch (e) {
                log.warning('Pagination failed or ended: ' + e.message);
                break;
            }
        }

        log.info(`Finished ${request.url}. Total reviews scraped: ${savedCount}`);
    },

    failedRequestHandler({ request }, error) {
        log.error(`Request ${request.url} failed: ${error.message}`);
    },
});

const initial = [];
if (Array.isArray(startUrls) && startUrls.length) {
    initial.push(...startUrls);
} else if (START_URL) {
    initial.push(START_URL);
}

await crawler.run(initial);
await Actor.exit();
