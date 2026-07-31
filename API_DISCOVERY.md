# API Discovery - Goodreads Review Scraper

## Selected API

Goodreads runs a Next.js frontend backed by an AWS AppSync GraphQL API. The
same API that powers the reviews page can be called directly over HTTP with a
public client-side API key embedded in the public JavaScript bundle. No login,
cookies, or browser are required.

- **Endpoint**: `https://kxbwmqov6jgg3daaamb744ycu4.appsync-api.us-east-1.amazonaws.com/graphql`
- **Method**: POST
- **Auth**: API key header `X-Api-Key: da2-xpgsdydkbregjhpr6ejzqdhuwy` (public client key, no signing)
- **Headers**: `Content-Type: application/json`, `X-Api-Key`
- **Pagination**: cursor-based via `PaginationInput { after, before, limit }` with `pageInfo.nextPageToken` / `pageInfo.prevPageToken`
- **Field count**: 16+ on each review node (vs 7 collected by the old HTML actor)

### Queries used

1. Resolve a legacy book id to its internal book/work ids:

```graphql
query getBookByLegacyId($legacyBookId: Int!) {
    getBookByLegacyId(legacyId: $legacyBookId) {
        id
        title
        work {
            id
        }
    }
}
```

2. Fetch reviews for a work (cursor pagination):

```graphql
query getReviews($filters: BookReviewsFilterInput!, $pagination: PaginationInput) {
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
}
```

Variables for a book reviews URL:

```json
{
    "filters": { "resourceType": "WORK", "resourceId": "<workId>" },
    "pagination": { "limit": 30 }
}
```

`resourceId` must be the internal `kca://work/...` URI (the numeric legacy id
returns 0 results). The legacy id is parsed from `/book/show/<id>-...` URLs and
resolved to the work id with query 1.

## Fields available (review node + relations)

| Field                                                                      | Source      | Notes                                  |
| -------------------------------------------------------------------------- | ----------- | -------------------------------------- |
| `id`                                                                       | review node | stable `kca://review:goodreads/...` id |
| `rating`                                                                   | review node | 1-5 or null                            |
| `createdAt`                                                                | review node | epoch ms                               |
| `likeCount`                                                                | review node | helpful votes                          |
| `commentCount`                                                             | review node | comments                               |
| `text`                                                                     | review node | raw HTML (needs cleaning)              |
| `spoilerStatus`                                                            | review node | available                              |
| `creator.id` / `creator.name` / `creator.webUrl`                           | creator     | reviewer identity                      |
| `creator.followersCount` / `creator.isAuthor` / `creator.textReviewsCount` | creator     | available                              |
| `shelving.webUrl`                                                          | shelving    | the review URL (`/review/show/...`)    |
| `totalCount`                                                               | connection  | total review count                     |
| `pageInfo`                                                                 | connection  | pagination cursors                     |

## Fields currently missing in the old actor

- `comment_count`, `reviewer_profile_url`, `review_id`, `book_title`, `book_id`

## Rejected candidates

- **URLScan.io**: the homepage scan exists but result API returned 403 for the
  scan; JS bundle analysis was used instead and proved faster.
- **`?_next/data/<buildId>/...json`**: returned an error over plain HTTP.
- **Classic `?page=2`**: returns the same first-page payload; no pagination.
- **`__NEXT_DATA__` + DOM fallback**: works for the first 30 reviews but has no
  pagination path over HTTP; used only as a resilience fallback.

## Score

| Factor                         | Points  |
| ------------------------------ | ------- |
| Returns JSON directly          | +30     |
| >15 unique fields              | +25     |
| No auth required               | +20     |
| Has pagination                 | +15     |
| Matches/extends current fields | +10     |
| **Total**                      | **100** |

## Behavior notes

- The GraphQL response can include a partial `errors` array (for example
  `RESOURCE_NOT_FOUND` on `commentCount` for removed reviews) while still
  returning valid `data`. Handle with `errorPolicy: "all"` semantics - keep the
  data, leave missing fields null.
- The web client filters edges whose node has neither a `shelving` nor a
  positive `rating`; the actor applies the same filter.
- Some edge nodes are `null`; they are skipped.
- `text` contains HTML (spoiler checkboxes, images, bold/italic); it is
  converted to plain text before saving.
- `createdAt` is epoch milliseconds and is formatted as `Mon D, YYYY`.
