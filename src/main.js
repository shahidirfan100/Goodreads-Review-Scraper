import { Actor, log } from 'apify';
import * as cheerio from 'cheerio';
import { Impit } from 'impit';
import { CookieJar } from 'tough-cookie';

const GRAPHQL_ENDPOINT = 'https://kxbwmqov6jgg3daaamb744ycu4.appsync-api.us-east-1.amazonaws.com/graphql';
const GRAPHQL_API_KEY = 'da2-xpgsdydkbregjhpr6ejzqdhuwy';
const REVIEWS_PER_PAGE = 30;
const MAX_RETRIES = 4;
const MAX_PAGINATION_GUARD = 10000;
const INTERNAL_CONCURRENCY = 3;
const REQUEST_TIMEOUT_MS = 60000;

const BOOK_QUERY = `query getBookByLegacyId($legacyBookId: Int!) {
    getBookByLegacyId(legacyId: $legacyBookId) {
        id
        legacyId
        title
        work {
            id
        }
    }
}`;

const REVIEWS_QUERY = `query getReviews($filters: BookReviewsFilterInput!, $pagination: PaginationInput) {
    getReviews(filters: $filters, pagination: $pagination) {
        totalCount
        pageInfo {
            __typename
            prevPageToken
            nextPageToken
        }
        edges {
            node {
                id
                rating
                createdAt
                likeCount
                commentCount
                text
                creator {
                    id
                    name
                    webUrl
                }
                shelving {
                    webUrl
                }
            }
        }
    }
}`;

const formatReviewDate = (value) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return null;
    }
    try {
        return new Intl.DateTimeFormat('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            timeZone: 'UTC',
        }).format(new Date(value));
    } catch {
        return null;
    }
};

const decodeEntities = (value) => {
    if (typeof value !== 'string') {
        return null;
    }
    return cheerio.load(value).root().text();
};

const normalizeText = (value) => {
    if (typeof value !== 'string') {
        return null;
    }
    const cleaned = value.replace(/\s+/g, ' ').trim();
    return cleaned || null;
};

const htmlToText = (html) => {
    if (typeof html !== 'string' || !html.trim()) {
        return null;
    }
    const withBreaks = html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|blockquote|ul|ol|tr)>/gi, '\n');
    const $ = cheerio.load(withBreaks, null, false);
    const text = $.root()
        .text()
        .replace(/\r/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return text || null;
};

const extractBookId = (url) => {
    const match = String(url).match(/book\/show\/(\d+)/);
    return match ? Number(match[1]) : null;
};

const mapReviewNode = (node, { inputUrl, book }) => {
    if (!node || typeof node !== 'object') {
        return null;
    }
    if (!node.shelving && !(Number(node.rating) > 0)) {
        return null;
    }
    return {
        review_id: normalizeText(node.id),
        reviewer_name: normalizeText(decodeEntities(node.creator?.name)),
        reviewer_profile_url: normalizeText(node.creator?.webUrl),
        rating: Number.isFinite(node.rating) ? node.rating : null,
        date: formatReviewDate(node.createdAt),
        review_text: htmlToText(node.text),
        helpful_count: Number.isFinite(node.likeCount) ? node.likeCount : 0,
        comment_count: Number.isFinite(node.commentCount) ? node.commentCount : 0,
        review_url: normalizeText(node.shelving?.webUrl),
        book_url: inputUrl,
        book_title: normalizeText(decodeEntities(book?.title)),
        book_id: normalizeText(book?.id),
    };
};

const resolveApolloNode = (apolloState, ref) => {
    if (!ref) {
        return null;
    }
    const node = apolloState[ref];
    if (!node) {
        return null;
    }
    // Apollo cache uses `__ref` keys to reference entities by id.
    // eslint-disable-next-line no-underscore-dangle
    const creatorRef = node.creator?.__ref;
    // eslint-disable-next-line no-underscore-dangle
    const shelvingRef = node.shelving?.__ref;
    return {
        ...node,
        creator: creatorRef ? apolloState[creatorRef] : node.creator,
        shelving: shelvingRef ? apolloState[shelvingRef] : node.shelving,
    };
};

const extractReviewsFromNextData = (html) => {
    const match = String(html).match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!match) {
        return null;
    }
    try {
        const json = JSON.parse(match[1]);
        const apolloState = json?.props?.pageProps?.apolloState || {};
        const connection = apolloState?.ROOT_QUERY?.getReviews;
        if (!connection || !Array.isArray(connection.edges)) {
            return null;
        }
        const edges = connection.edges
            .map((edge) => {
                // Apollo cache uses `__ref` keys to reference entities by id.
                // eslint-disable-next-line no-underscore-dangle
                const nodeRef = edge?.node?.__ref;
                return { node: resolveApolloNode(apolloState, nodeRef) };
            })
            .filter((edge) => edge.node);
        return {
            edges,
            pageInfo: connection.pageInfo,
            totalCount: connection.totalCount,
        };
    } catch {
        return null;
    }
};

await Actor.init();

const input = (await Actor.getInput()) || {};
const { startUrls = [], results_wanted = 20, proxyConfiguration } = input;

const urls = (Array.isArray(startUrls) ? startUrls : [])
    .map((entry) => (typeof entry === 'string' ? entry : entry?.url))
    .filter(Boolean);

if (urls.length === 0) {
    log.error('No startUrls provided. Add at least one Goodreads book reviews URL to the startUrls input.');
    await Actor.exit();
    process.exit(0);
}

const isApifyCloud = Actor.isAtHome();
const shouldUseApifyProxy = Boolean(proxyConfiguration?.useApifyProxy);
const hasCustomProxyUrls = Array.isArray(proxyConfiguration?.proxyUrls) && proxyConfiguration.proxyUrls.length > 0;

let proxyUrl;
if ((shouldUseApifyProxy || hasCustomProxyUrls) && isApifyCloud) {
    const proxyConf = await Actor.createProxyConfiguration({ ...proxyConfiguration });
    proxyUrl = await proxyConf.newUrl();
} else if (shouldUseApifyProxy && !isApifyCloud) {
    log.info('Local run: skipping Apify Proxy because the actor is not running on the Apify Cloud.');
}

const cookieJar = new CookieJar();
const client = new Impit({
    browser: 'chrome',
    ignoreTlsErrors: true,
    timeout: REQUEST_TIMEOUT_MS,
    cookieJar,
    ...(proxyUrl ? { proxyUrl } : {}),
});

const sleep = (ms) =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

const buildGraphqlHeaders = (referer) => ({
    accept: 'application/json',
    'accept-language': 'en-US,en;q=0.9',
    'content-type': 'application/json',
    'x-api-key': GRAPHQL_API_KEY,
    origin: 'https://www.goodreads.com',
    referer,
    'sec-ch-ua-mobile': '?0',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'cross-site',
    'upgrade-insecure-requests': '',
    'sec-fetch-user': '',
});

const gql = async (query, variables, referer) => {
    let lastError;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const response = await client.fetch(GRAPHQL_ENDPOINT, {
                method: 'POST',
                headers: buildGraphqlHeaders(referer),
                body: JSON.stringify({ query, variables }),
            });

            const retryAfter = Number(response.headers.get('retry-after'));
            const waitFor = retryAfter > 0 ? retryAfter * 1000 : attempt * 1500 + Math.random() * 1000;

            if (response.status === 403) {
                log.warning(
                    `GraphQL API rejected the request (403). Retrying in ${Math.round(waitFor / 1000)}s (attempt ${attempt}/${MAX_RETRIES}).`,
                );
                await sleep(waitFor);
                continue;
            }

            if (response.status === 429) {
                log.warning(
                    `GraphQL API rate limited. Retrying in ${Math.round(waitFor / 1000)}s (attempt ${attempt}/${MAX_RETRIES}).`,
                );
                await sleep(waitFor);
                continue;
            }

            if (response.status === 408 || response.status >= 500) {
                log.warning(`GraphQL API server error ${response.status}. Retrying in ${Math.round(waitFor / 1000)}s.`);
                await sleep(waitFor);
                continue;
            }

            const body = await response.text();
            let json;
            try {
                json = JSON.parse(body);
            } catch {
                lastError = new Error('Invalid JSON response');
                log.warning(`GraphQL API returned invalid JSON (${body.slice(0, 200)}). Retrying.`);
                await sleep(attempt * 1000);
                continue;
            }

            if (json?.errors?.length && !json?.data) {
                lastError = new Error(json.errors.map((e) => e.message).join('; '));
                log.warning(`GraphQL API error: ${lastError.message}. Retrying.`);
                await sleep(attempt * 1000);
                continue;
            }

            return json;
        } catch (error) {
            lastError = error;
            if (attempt < MAX_RETRIES) {
                const wait = attempt * 1000 + Math.random() * 500;
                log.warning(`GraphQL request failed (${error.message}). Retrying in ${Math.round(wait / 1000)}s.`);
                await sleep(wait);
            }
        }
    }
    throw new Error(`All ${MAX_RETRIES} GraphQL requests failed: ${lastError?.message}`);
};

const fetchReviewsPageFromGraphql = async (workId, pagination, referer) => {
    const result = await gql(
        REVIEWS_QUERY,
        {
            filters: { resourceType: 'WORK', resourceId: workId },
            pagination,
        },
        referer,
    );
    return result?.data?.getReviews || null;
};

const fetchReviewsFromHtmlFallback = async (url) => {
    try {
        const response = await client.fetch(url);
        if (!response.ok) {
            return null;
        }
        const html = await response.text();
        return extractReviewsFromNextData(html);
    } catch (error) {
        log.warning(`HTML fallback failed for ${url}: ${error.message}`);
        return null;
    }
};

const collectBookReviews = async (inputUrl) => {
    const legacyBookId = extractBookId(inputUrl);
    if (!legacyBookId) {
        log.warning(`Could not parse a Goodreads book id from URL: ${inputUrl}`);
        return 0;
    }

    log.info(`Resolving book details for legacy id ${legacyBookId}.`);
    const bookData = await gql(BOOK_QUERY, { legacyBookId }, inputUrl);
    const book = bookData?.data?.getBookByLegacyId;
    const workId = book?.work?.id;
    if (!workId) {
        log.warning(`Could not resolve the work for book id ${legacyBookId} at ${inputUrl}.`);
        return 0;
    }

    log.info(`Collecting up to ${results_wanted} reviews for "${book.title}".`);
    const seenIds = new Set();
    const records = [];
    let after;
    let guard = 0;

    while (records.length < results_wanted && guard < MAX_PAGINATION_GUARD) {
        guard++;
        let connection = null;
        try {
            connection = await fetchReviewsPageFromGraphql(
                workId,
                {
                    limit: REVIEWS_PER_PAGE,
                    ...(after ? { after } : {}),
                },
                inputUrl,
            );
        } catch (error) {
            log.warning(`GraphQL review fetch failed (${error.message}). Trying the HTML fallback for the first page.`);
        }

        if (!connection) {
            if (records.length === 0) {
                connection = await fetchReviewsFromHtmlFallback(inputUrl);
            }
            if (!connection) {
                log.warning(
                    `No review data available for ${inputUrl}. Stopping pagination with ${records.length} reviews saved.`,
                );
                break;
            }
        }

        const edges = Array.isArray(connection.edges) ? connection.edges : [];
        if (edges.length === 0) {
            break;
        }

        const newRecords = [];
        for (const edge of edges) {
            const node = edge?.node;
            if (!node || !node.id) {
                continue;
            }
            if (seenIds.has(node.id)) {
                continue;
            }
            seenIds.add(node.id);
            const mapped = mapReviewNode(node, { inputUrl, book });
            if (mapped) {
                newRecords.push(mapped);
            }
        }

        if (newRecords.length > 0) {
            const remaining = results_wanted - records.length;
            const batch = newRecords.slice(0, remaining);
            records.push(...batch);
            await Actor.pushData(batch);
        }

        log.info(
            `Saved ${Math.min(records.length, results_wanted)}/${results_wanted} reviews for "${book.title}" (total available: ${connection.totalCount ?? 'unknown'}).`,
        );

        if (records.length >= results_wanted) {
            break;
        }

        const nextToken = connection.pageInfo?.nextPageToken;
        if (!nextToken) {
            break;
        }
        after = nextToken;
    }

    return records.length;
};

let totalSaved = 0;
let processed = 0;
let nextUrlIndex = 0;

const processUrl = async () => {
    while (nextUrlIndex < urls.length) {
        const inputUrl = urls[nextUrlIndex++];
        processed++;
        try {
            const saved = await collectBookReviews(inputUrl);
            totalSaved += saved;
            log.info(`Finished ${inputUrl}. Saved ${saved} reviews.`);
        } catch (error) {
            log.error(`Failed to process ${inputUrl}: ${error.message}`);
        }
    }
};

const workers = Array.from({ length: Math.min(INTERNAL_CONCURRENCY, urls.length) }, () => processUrl());
await Promise.all(workers);

log.info(`Extraction complete. Processed ${processed} URLs, saved ${totalSaved} reviews in total.`);
await Actor.exit();
