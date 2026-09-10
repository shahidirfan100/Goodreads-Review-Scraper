import { Actor, log } from 'apify';
import * as cheerio from 'cheerio';
import { Impit } from 'impit';
import { CookieJar } from 'tough-cookie';

const GRAPHQL_ENDPOINT = 'https://kxbwmqov6jgg3daaamb744ycu4.appsync-api.us-east-1.amazonaws.com/graphql';

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

const parseNextData = (html) => {
    const match = String(html).match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!match) {
        return null;
    }
    try {
        return JSON.parse(match[1]);
    } catch {
        return null;
    }
};

const resolveApolloReference = (apolloState, value) => {
    // eslint-disable-next-line no-underscore-dangle
    const ref = value?.__ref;
    return ref ? apolloState[ref] : value;
};

const extractBootstrapData = (html) => {
    const json = parseNextData(html);
    if (!json) {
        return null;
    }
    const apolloState = json.props?.pageProps?.apolloState || {};
    const rootQuery = apolloState.ROOT_QUERY || {};
    const reviewKey = Object.keys(rootQuery).find((key) => key === 'getReviews' || key.startsWith('getReviews('));
    const connection = reviewKey ? rootQuery[reviewKey] : null;
    const bookKey = Object.keys(rootQuery).find((key) => key.startsWith('getBookByLegacyId('));
    // eslint-disable-next-line no-underscore-dangle
    const bookRef = bookKey ? rootQuery[bookKey]?.__ref : null;
    const rawBook = bookRef ? apolloState[bookRef] : null;
    const book = rawBook
        ? {
              ...rawBook,
              work: resolveApolloReference(apolloState, rawBook.work),
          }
        : null;

    if (!connection || !Array.isArray(connection.edges)) {
        return {
            apiKey: json?.props?.pageProps?.apiKey,
            book,
            connection: null,
        };
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
        apiKey: json?.props?.pageProps?.apiKey,
        book,
        connection: {
            edges,
            pageInfo: connection.pageInfo,
            totalCount: connection.totalCount,
        },
    };
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

const isAuthorizationError = (message) => /not authorized|unauthorized|forbidden/i.test(String(message));

const buildGraphqlHeaders = (referer, apiKey) => ({
    accept: 'application/json',
    'accept-language': 'en-US,en;q=0.9',
    'content-type': 'application/json',
    'x-api-key': apiKey,
    origin: 'https://www.goodreads.com',
    referer,
    'sec-ch-ua-mobile': '?0',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'cross-site',
    'upgrade-insecure-requests': '',
    'sec-fetch-user': '',
});

const gql = async (query, variables, referer, apiKey) => {
    if (!apiKey) {
        throw new Error('Goodreads page did not provide a GraphQL API key');
    }

    let lastError;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const response = await client.fetch(GRAPHQL_ENDPOINT, {
                method: 'POST',
                headers: buildGraphqlHeaders(referer, apiKey),
                body: JSON.stringify({ query, variables }),
            });

            const retryAfter = Number(response.headers.get('retry-after'));
            const waitFor = retryAfter > 0 ? retryAfter * 1000 : attempt * 1500 + Math.random() * 1000;

            if (response.status === 429 || response.status === 408 || response.status >= 500) {
                lastError = new Error(`HTTP ${response.status}`);
                if (attempt < MAX_RETRIES) {
                    log.warning(
                        `GraphQL API request returned ${response.status}. Retrying in ${Math.round(waitFor / 1000)}s (attempt ${attempt}/${MAX_RETRIES}).`,
                    );
                    await sleep(waitFor);
                    continue;
                }
                break;
            }

            const body = await response.text();
            let json;
            try {
                json = JSON.parse(body);
            } catch {
                throw new Error('GraphQL API returned invalid JSON');
            }

            if (json?.errors?.length && !json?.data) {
                lastError = new Error(json.errors.map((e) => e.message).join('; '));
                if (isAuthorizationError(lastError.message)) {
                    throw lastError;
                }
                if (attempt < MAX_RETRIES) {
                    log.warning(`GraphQL API error: ${lastError.message}. Retrying.`);
                    await sleep(waitFor);
                    continue;
                }
                break;
            }

            if (!response.ok) {
                throw new Error(`GraphQL API returned HTTP ${response.status}`);
            }

            return json;
        } catch (error) {
            lastError = error;
            const isPermanentError =
                isAuthorizationError(error.message) || /invalid JSON|HTTP 4\d{2}/i.test(error.message);
            if (isPermanentError) {
                throw error;
            }
            if (attempt < MAX_RETRIES) {
                const wait = attempt * 1000 + Math.random() * 500;
                log.warning(`GraphQL request failed (${error.message}). Retrying in ${Math.round(wait / 1000)}s.`);
                await sleep(wait);
            }
        }
    }
    throw new Error(`All ${MAX_RETRIES} GraphQL requests failed: ${lastError?.message}`);
};

const fetchReviewsPageFromGraphql = async (workId, pagination, referer, apiKey) => {
    const result = await gql(
        REVIEWS_QUERY,
        {
            filters: { resourceType: 'WORK', resourceId: workId },
            pagination,
        },
        referer,
        apiKey,
    );
    return result?.data?.getReviews || null;
};

const fetchPageBootstrap = async (url) => {
    try {
        const response = await client.fetch(url, {
            headers: {
                accept: 'text/html,application/xhtml+xml',
                'accept-language': 'en-US,en;q=0.9',
            },
        });
        if (!response.ok || response.status === 202) {
            const reason = response.status === 202 ? ' (likely AWS WAF challenge)' : '';
            log.warning(`Goodreads page returned HTTP ${response.status}${reason} for ${url}.`);
            return null;
        }
        const html = await response.text();
        const bootstrap = extractBootstrapData(html);
        if (!bootstrap) {
            log.warning(`Goodreads page did not contain usable bootstrap data for ${url}.`);
        }
        return bootstrap;
    } catch (error) {
        log.warning(`Goodreads page bootstrap failed for ${url}: ${error.message}`);
        return null;
    }
};

const fetchReviewsFromHtmlFallback = async (url, bootstrap) => {
    if (bootstrap?.connection) {
        return bootstrap.connection;
    }
    const page = await fetchPageBootstrap(url);
    return page?.connection || null;
};

const collectBookReviews = async (inputUrl) => {
    const legacyBookId = extractBookId(inputUrl);
    if (!legacyBookId) {
        log.warning(`Could not parse a Goodreads book id from URL: ${inputUrl}`);
        return 0;
    }

    let bootstrap = await fetchPageBootstrap(inputUrl);
    let apiKey = typeof bootstrap?.apiKey === 'string' ? bootstrap.apiKey.trim() : null;
    let book = bootstrap?.book;
    let workId = book?.work?.id;

    log.info(`Resolving book details for legacy id ${legacyBookId}.`);
    try {
        const bookData = await gql(BOOK_QUERY, { legacyBookId }, inputUrl, apiKey);
        book = bookData?.data?.getBookByLegacyId || book;
        workId = book?.work?.id || workId;
    } catch (error) {
        log.warning(`GraphQL book lookup failed (${error.message}). Trying the page bootstrap.`);
    }

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
                apiKey,
            );
        } catch (error) {
            log.warning(`GraphQL review fetch failed (${error.message}). Trying the HTML fallback for the first page.`);
            if (isAuthorizationError(error.message)) {
                const refreshedBootstrap = await fetchPageBootstrap(inputUrl);
                const refreshedApiKey =
                    typeof refreshedBootstrap?.apiKey === 'string' ? refreshedBootstrap.apiKey.trim() : null;
                if (refreshedApiKey && refreshedApiKey !== apiKey) {
                    log.info('Goodreads published a new GraphQL key. Retrying the review request.');
                    bootstrap = refreshedBootstrap;
                    apiKey = refreshedApiKey;
                    try {
                        connection = await fetchReviewsPageFromGraphql(
                            workId,
                            {
                                limit: REVIEWS_PER_PAGE,
                                ...(after ? { after } : {}),
                            },
                            inputUrl,
                            apiKey,
                        );
                    } catch (refreshError) {
                        log.warning(`GraphQL review retry after key refresh failed (${refreshError.message}).`);
                    }
                }
            }
        }

        if (!connection) {
            if (records.length === 0) {
                connection = await fetchReviewsFromHtmlFallback(inputUrl, bootstrap);
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
