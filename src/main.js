// Goodreads Review Scraper - Playwright Chrome implementation
import { Actor, log } from 'apify';
import { PlaywrightCrawler, Dataset } from 'crawlee';

await Actor.init();

const input = (await Actor.getInput()) || {};
const BUILD_MARKER = 'date-fix-2026-02-11';
log.info(`Build marker: ${BUILD_MARKER}`);

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
            // Block heavy resources and tracking
            await page.route('**/*', (route) => {
                const request = route.request();
                const type = request.resourceType();
                const url = request.url();

                // Block heavy content
                if (['image', 'media', 'font', 'stylesheet'].includes(type) && !url.includes('goodreads')) {
                    // Be careful with stylesheets, goodreads needs them for layout-dependent text visibility sometimes, 
                    // but purely text-based extraction might be fine. 
                    // Let's safe-list goodreads CSS if we block it, but usually blocking all external is safer.
                    // The user requested to "make playwright light", so we block aggressively.
                }

                if (['image', 'media', 'font'].includes(type)) {
                    return route.abort();
                }

                // Block known trackers/ads
                if (url.includes('amazon-ad-system') ||
                    url.includes('googletagservices') ||
                    url.includes('google-analytics') ||
                    url.includes('doubleclick') ||
                    url.includes('facebook') ||
                    url.includes('criteo') ||
                    url.includes('scorecardresearch')) {
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

        // Wait for first batch of reviews to actually appear in the DOM
        try {
            await page.waitForSelector('article.ReviewCard', { timeout: 15000 });
        } catch (e) {
            log.warning('Timed out waiting for ReviewCard selector. The page might be empty or blocked.');
        }

        // Helper to remove any and all overlays that might block interactions
        const cleanOverlays = async () => {
            await page.evaluate(() => {
                const overlays = document.querySelectorAll('.Overlay, [class*="Overlay"], [class*="Modal"], [class*="onboarding"]');
                overlays.forEach(el => el.remove());
                document.body.style.overflow = 'auto'; // Re-enable scrolling if modal disabled it
            }).catch(() => { });
        };

        await cleanOverlays();

        let savedCount = 0;
        const seenIds = new Set();
        let loopCount = 0;
        const MAX_LOOPS = 50;
        let stalledPaginationAttempts = 0;

        while (savedCount < RESULTS_WANTED && loopCount < MAX_LOOPS) {
            loopCount++;
            log.info(`Scraping loop ${loopCount}, saved so far: ${savedCount}`);

            // API-first extraction with DOM fallback.
            const reviews = await page.evaluate(() => {
                const extracted = [];
                const seenInBatch = new Set();

                const monthDateRegex = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s+\d{4}\b/i;
                const numericDateRegex = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/;

                const normalizeString = (value) => {
                    if (typeof value !== 'string') return null;
                    const cleaned = value.replace(/\s+/g, ' ').trim();
                    return cleaned || null;
                };

                const findDateInText = (value) => {
                    const text = normalizeString(value);
                    if (!text) return null;
                    const monthMatch = text.match(monthDateRegex);
                    if (monthMatch) return monthMatch[0];
                    const numericMatch = text.match(numericDateRegex);
                    if (numericMatch) return numericMatch[0];
                    return null;
                };

                const formatTimestamp = (value) => {
                    const numericValue = typeof value === 'string' ? Number(value) : value;
                    if (typeof numericValue !== 'number' || !Number.isFinite(numericValue) || numericValue <= 0) return null;
                    try {
                        return new Intl.DateTimeFormat('en-US', {
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric',
                            timeZone: 'UTC',
                        }).format(new Date(numericValue));
                    } catch {
                        return null;
                    }
                };

                const htmlToText = (value) => {
                    const text = normalizeString(value);
                    if (!text) return null;

                    if (!/[<>]/.test(text)) return text;

                    const parser = document.createElement('div');
                    parser.innerHTML = text;
                    return normalizeString(parser.textContent);
                };

                // Priority 1: __NEXT_DATA__ / Apollo state (API-first)
                try {
                    const nextDataScript = document.querySelector('script#__NEXT_DATA__');
                    if (nextDataScript?.textContent) {
                        const nextData = JSON.parse(nextDataScript.textContent);
                        const apolloState = nextData?.props?.pageProps?.apolloState || {};
                        const rootQuery = apolloState?.ROOT_QUERY || {};
                        const reviewsConnection =
                            rootQuery?.getReviews
                            || Object.entries(rootQuery).find(([key, value]) =>
                                /^getReviews\b/.test(key) && Array.isArray(value?.edges)
                            )?.[1];
                        const edges = Array.isArray(reviewsConnection?.edges) ? reviewsConnection.edges : [];

                        for (const edge of edges) {
                            const ref = edge?.node?.__ref;
                            if (!ref) continue;

                            const review = apolloState[ref];
                            if (!review) continue;

                            const userRef = review?.creator?.__ref;
                            const user = userRef ? apolloState[userRef] : null;
                            const reviewerName = normalizeString(user?.name);
                            if (!reviewerName) continue;

                            const reviewUrl = normalizeString(review?.shelving?.webUrl);
                            const id = reviewUrl || normalizeString(review?.id) || `${reviewerName}-${review?.createdAt || ''}`;
                            if (!id || seenInBatch.has(id)) continue;
                            seenInBatch.add(id);

                            extracted.push({
                                id,
                                reviewerName,
                                rating: typeof review?.rating === 'number' ? review.rating : null,
                                date: formatTimestamp(review?.createdAt),
                                text: htmlToText(review?.text),
                                url: reviewUrl && reviewUrl.includes('/review/show/') ? reviewUrl : null,
                                helpfulCount: Number.isFinite(review?.likeCount) ? review.likeCount : 0,
                                source: 'next_data',
                            });
                        }
                    }
                } catch {
                    // Keep crawling using DOM extraction fallback.
                }

                const reviewCards = document.querySelectorAll('article.ReviewCard');

                reviewCards.forEach((card, idx) => {
                    const name = normalizeString(card.querySelector('.ReviewerProfile__name a, [data-testid="name"]')?.innerText);

                    const ratingLabel = card.querySelector('.RatingStars')?.getAttribute('aria-label'); // "Rating 4 out of 5"
                    const ratingMatch = ratingLabel?.match(/Rating (\d+(\.\d+)?) out of 5/);
                    const rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;

                    const timeDateRaw = card.querySelector('time[datetime]')?.getAttribute('datetime');
                    let date = timeDateRaw ? formatTimestamp(new Date(timeDateRaw).getTime()) : null;

                    if (!date) {
                        const dateCandidates = [
                            card.querySelector('.ReviewCard__contentHeader a')?.innerText,
                            card.querySelector('.ReviewCard__contentHeader span')?.innerText,
                            card.querySelector('[data-testid="contentHeader"] a')?.innerText,
                            card.querySelector('[data-testid="contentHeader"] span')?.innerText,
                            card.querySelector('[data-testid*="date" i]')?.innerText,
                            card.innerText,
                        ];
                        for (const candidate of dateCandidates) {
                            const parsedDate = findDateInText(candidate);
                            if (parsedDate) {
                                date = parsedDate;
                                break;
                            }
                        }
                    }

                    // Prioritize full text if available
                    let text = card.querySelector('.ReviewText__content--full')?.innerText;
                    if (!text) {
                        text = card.querySelector('.ReviewText__content')?.innerText;
                    }

                    // Helpful Count (Likes)
                    let helpfulCount = 0;
                    const statsButtons = card.querySelectorAll('.SocialFooter__stats button, [class*="SocialFooter"] button');
                    statsButtons.forEach(btn => {
                        const btnText = btn.innerText || '';
                        if (btnText.includes('likes') || btnText.includes('like')) {
                            const countMatch = btnText.match(/(\d+)/);
                            if (countMatch) {
                                helpfulCount = parseInt(countMatch[1], 10);
                            }
                        }
                    });

                    const urlPath = card.querySelector('.ReviewCard__content a[href*="/review/show"]')?.getAttribute('href');
                    const url = urlPath ? new URL(urlPath, document.location.origin).href : null;

                    // Stable ID: Use URL or combined name/rating/index (avoid Date.now)
                    const id = url || `review-${name || 'unknown'}-${idx}`;

                    if (name && !seenInBatch.has(id)) {
                        seenInBatch.add(id);
                        extracted.push({
                            id,
                            reviewerName: name,
                            rating,
                            date,
                            text,
                            url,
                            helpfulCount,
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
                    const normalizedDate = typeof r.date === 'string' && r.date.trim()
                        ? r.date.trim()
                        : null;

                    newReviews.push({
                        reviewer_name: r.reviewerName,
                        rating: r.rating,
                        date: normalizedDate,
                        review_text: r.text,
                        helpful_count: r.helpfulCount,
                        review_url: r.url,
                        book_url: request.url
                    });
                }
            }

            if (newReviews.length > 0) {
                const remaining = RESULTS_WANTED - savedCount;
                const toSave = newReviews.slice(0, Math.max(0, remaining));
                if (toSave.length > 0) {
                    await Dataset.pushData(toSave);
                    savedCount += toSave.length;
                    log.info(`Saved ${toSave.length} new reviews from total extracted ${newReviews.length}. Total saved: ${savedCount}`);
                }
            } else {
                log.info('No new reviews found in this loop.');
            }

            if (newReviews.length > 0) {
                stalledPaginationAttempts = 0;
            }

            if (savedCount >= RESULTS_WANTED) break;

            // Pagination: Click "Show more reviews" (or navigate next) until results end
            try {
                await cleanOverlays(); // Ensure nothing is blocking right before click

                const loadMoreBtn = page
                    .locator('button:has-text("Show more reviews"), button[data-testid="loadMore"], button[class*="Button"]:has-text("Show more")')
                    .first();
                const nextPageLink = page.locator('a[rel="next"], a[aria-label*="next"], button[aria-label*="next"]');
                const loadMoreVisible = await loadMoreBtn.isVisible().catch(() => false);

                if (loadMoreVisible) {
                    log.info('Clicking "Show more reviews"...');

                    const knownIdsSnapshot = Array.from(seenIds);

                    await loadMoreBtn.scrollIntoViewIfNeeded();
                    try {
                        // Attempt a forceful click via Playwright, then fallback to JS click
                        await loadMoreBtn.click({ timeout: 5000, force: true });
                    } catch (err) {
                        log.warning(`Click failed: ${err.message}. Trying direct JS click.`);
                        await page.evaluate(() => {
                            const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Show more reviews') || b.innerText.includes('Show more'));
                            if (btn) btn.click();
                        });
                    }

                    const newContentAppeared = await page
                        .waitForFunction(
                            (knownIds) => {
                                const cards = Array.from(document.querySelectorAll('article.ReviewCard'));

                                const ids = cards
                                    .map((card, idx) => {
                                        const urlPath = card
                                            .querySelector('.ReviewCard__content a[href*="/review/show"]')
                                            ?.getAttribute('href');
                                        const name = card.querySelector('.ReviewerProfile__name a, [data-testid="name"]')
                                            ?.innerText;
                                        const id = urlPath
                                            ? new URL(urlPath, document.location.origin).href
                                            : name
                                                ? `review-${name}-${idx}`
                                                : null;
                                        return id;
                                    })
                                    .filter(Boolean);

                                if (ids.length > knownIds.length) return true;
                                return ids.some((id) => !knownIds.includes(id));
                            },
                            knownIdsSnapshot,
                            { timeout: 15000 }
                        )
                        .catch(() => false);

                    if (!newContentAppeared) {
                        stalledPaginationAttempts++;
                        log.warning('Pagination click did not surface new review cards; retrying.');

                        if (stalledPaginationAttempts >= 3) {
                            log.info('Stopping pagination after repeated empty attempts.');
                            break;
                        }

                        await page.waitForTimeout(1500);
                        continue;
                    }

                    stalledPaginationAttempts = 0;
                    await page.waitForTimeout(800);
                    continue;
                }

                // Fallback: plain next link if present
                if (await nextPageLink.isVisible().catch(() => false)) {
                    log.info('Navigating to the next reviews page...');
                    await Promise.all([
                        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null),
                        nextPageLink.click({ timeout: 5000 }),
                    ]);
                    stalledPaginationAttempts = 0;
                    await page.waitForTimeout(1000);
                    continue;
                } else {
                    log.info('No more reviews to load.');
                    break;
                }
            } catch (e) {
                log.warning('Pagination failed: ' + e.message);
                break;
            }
        }

        log.info(`Finished processing ${request.url}. Final count: ${savedCount}`);
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
