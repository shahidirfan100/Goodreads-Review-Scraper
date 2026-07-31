## What does Goodreads Review Scraper do?

Goodreads Review Scraper collects book reviews and reader feedback from public Goodreads book review pages. Paste a Goodreads book reviews URL such as `https://www.goodreads.com/book/show/2767052-the-catcher-in-the-rye/reviews`, choose how many reviews you need, and the Actor saves reviewer names, profile URLs, star ratings, review dates, full review text, helpful and comment counts, review URLs, and book details into a clean dataset. It automatically loads all available reviews until your target count is reached, so you can build ready-to-use datasets for market research, sentiment analysis, and reader feedback tracking without manual copy-paste.

The Actor talks directly to the same GraphQL API that powers the Goodreads reviews page, so it needs no browser, is fast, and is much harder to block than HTML scraping. It emulates a Chrome browser over TLS, sends realistic cross-origin fetch headers and a persistent cookie session, and auto-retries transient failures, so runs stay smooth and under the radar.

## Why use Goodreads Review Scraper?

- **Reliable dataset creation** - Collect structured review data from Goodreads without manual copy-paste or endless scrolling.
- **Automation-ready output** - Export results to JSON, CSV, Excel, XML, or connect them to your data tools.
- **Use-case fit** - Supports market research, sentiment analysis, competitive intelligence, and AI and RAG data collection.

## What data can you extract from Goodreads?

| Field                  | Description                                          |
| ---------------------- | ---------------------------------------------------- |
| `review_id`            | Unique identifier of the review                      |
| `reviewer_name`        | Name of the person who wrote the review              |
| `reviewer_profile_url` | Goodreads profile URL of the reviewer                |
| `rating`               | Star rating given by the reader (1 to 5)             |
| `date`                 | Date the review was published                        |
| `review_text`          | Full text of the review                              |
| `helpful_count`        | Number of likes or helpful votes the review received |
| `comment_count`        | Number of comments on the review                     |
| `review_url`           | Direct link to the original review                   |
| `book_url`             | Goodreads URL the review was collected from          |
| `book_title`           | Title of the book the review belongs to              |
| `book_id`              | Internal identifier of the book                      |

## How to use Goodreads Review Scraper

1. Open the Actor on Apify Store.
2. Add one or more Goodreads book reviews page URLs.
3. Set the maximum number of reviews to collect.
4. Run the Actor.
5. Download the dataset or connect it to your workflow.

## Input Parameters

| Parameter            | Type    | Required | Default                    | Description                                                                                               |
| -------------------- | ------- | -------- | -------------------------- | --------------------------------------------------------------------------------------------------------- |
| `startUrls`          | Array   | No       | `[]`                       | One or more Goodreads book reviews page URLs to collect from. Provide at least one URL for useful results |
| `results_wanted`     | Integer | No       | `20`                       | Maximum number of reviews to collect per book                                                             |
| `proxyConfiguration` | Object  | No       | `{"useApifyProxy": false}` | Proxy settings; residential proxies are recommended for large runs                                        |

## Usage Examples

### Basic Review Extraction

Collect the first 20 reviews for one book:

```json
{
    "startUrls": ["https://www.goodreads.com/book/show/2767052-the-catcher-in-the-rye/reviews"],
    "results_wanted": 20
}
```

### Collect Reviews for Multiple Books

Gather reviews for several books in a single run:

```json
{
    "startUrls": [
        "https://www.goodreads.com/book/show/2767052-the-catcher-in-the-rye/reviews",
        "https://www.goodreads.com/book/show/4671-the-great-gatsby/reviews",
        "https://www.goodreads.com/book/show/1885-pride-and-prejudice/reviews"
    ],
    "results_wanted": 50
}
```

### High-Volume Collection

Collect a large review dataset with residential proxies:

```json
{
    "startUrls": ["https://www.goodreads.com/book/show/2767052-the-catcher-in-the-rye/reviews"],
    "results_wanted": 1000,
    "proxyConfiguration": {
        "useApifyProxy": true,
        "apifyProxyGroups": ["RESIDENTIAL"]
    }
}
```

## Sample Output

```json
{
    "review_id": "kca://review:goodreads/amzn1.gr.review:goodreads.v1.X123456",
    "reviewer_name": "Alexander",
    "reviewer_profile_url": "https://www.goodreads.com/user/show/123456789-alexander",
    "rating": 5,
    "date": "Jan 15, 2024",
    "review_text": "One of the most important books I have ever read. The character development is unmatched and the themes remain relevant decades later.",
    "helpful_count": 42,
    "comment_count": 7,
    "review_url": "https://www.goodreads.com/review/show/123456789",
    "book_url": "https://www.goodreads.com/book/show/2767052-the-catcher-in-the-rye/reviews",
    "book_title": "The Hunger Games",
    "book_id": "kca://book/amzn1.gr.book.v1.YaoKZD8xVx72w5T1ZgR1YQ"
}
```

## Tips for Best Results

- Use complete public Goodreads reviews URLs that end in `/reviews`.
- Start with a small `results_wanted` value to confirm the data looks correct before running large jobs.
- For large datasets, residential proxies give the most reliable results.
- Check the dataset preview before scheduling repeat runs.
- Some reviews may not include a rating, date, review URL, or helpful count. These fields can be empty when the source does not publish that information.
- The Actor filters out duplicate reviews and skips empty review entries automatically.

## Integrations

- **Google Sheets** - Send scraped reviews to spreadsheets.
- **Webhooks** - Trigger downstream workflows after each run.
- **Make or Zapier** - Connect review data to no-code automations.
- **API** - Access datasets programmatically from your own systems.
- **CSV, Excel, JSON, XML** - Download results in the format that fits your workflow.

## Frequently Asked Questions

### Can I export the data to CSV or Excel?

Yes. Apify datasets can be downloaded in CSV, Excel, JSON, XML, and other supported formats.

### Can I run this Actor on a schedule?

Yes. You can schedule the Actor in Apify Console to refresh review data hourly, daily, weekly, or at another interval.

### How many reviews can I collect per book?

You can collect as many publicly available reviews as you need by increasing `results_wanted`. The Actor loads reviews through the Goodreads GraphQL API until it reaches your target count or runs out of reviews for the book.

### Can I collect reviews for multiple books at once?

Yes. Add several Goodreads book reviews page URLs to the `startUrls` field and the Actor processes them in one run.

### Do I need a Goodreads account?

No. The Actor uses the same public API that powers the reviews page and does not require login credentials or a browser.

### What should I do if some fields are missing?

Some reviews may not show a rating, date, or helpful count. Reviewers can post reviews without a star rating, and short reviews may have no likes. Check several results before assuming the Actor failed.

### Is it legal to scrape Goodreads?

Scraping public web data can be legal, but you are responsible for complying with applicable laws, website terms, and privacy rules.

## Related Actors

- [Goodreads Books Scraper](https://apify.com/shahidirfan/goodreads-book-scraper) - Collect book details and metadata from Goodreads.
- [Goodreads Quotes](https://apify.com/shahidirfan/goodreads-quotes) - Extract popular book quotes from Goodreads.
- [Open Library Book Finder](https://apify.com/shahidirfan/open-library-book-finder) - Find and collect book data from Open Library.

## Support

For issues, feature requests, or custom Actor work, use the Issues tab on the Actor page or contact the developer through Apify.

## Legal Notice

This Actor is designed for legitimate data collection from publicly available Goodreads pages. Users are responsible for using the data responsibly and complying with applicable laws and website terms.
