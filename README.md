# Goodreads Review Scraper

Extract comprehensive book reviews and reader feedback from Goodreads with ease. Collect detailed reviewer information, star ratings, and full review content at scale. Perfect for market research, sentiment analysis, and building literary datasets.

---

## Features

- **Deep Data Extraction** — Capture names, ratings, and full review text from any book page.
- **Automated Pagination** — Automatically scroll and load all available reviews without manual effort.
- **Reliable Performance** — Built-in protection to ensure consistent data collection from protected pages.
- **Optimized Bandwidth** — Intelligent resource handling for faster execution and lower costs.
- **Flexible Results** — Set specific limits on how many reviews you need for your analysis.

---

## Use Cases

### Market Research for Authors
Analyze reader feedback on similar titles to understand audience expectations, common tropes they love, and frequent complaints they have.

### Sentiment Analysis
Gather large-scale textual data for NLP models to determine reader sentiment trends across different genres or publication years.

### Competitor Intelligence
Track how readers respond to competing book releases in real-time to adjust your marketing and positioning strategies.

### Data-Driven Recommendations
Build comprehensive datasets of user preferences to power custom recommendation engines and literary apps.

---

## Input Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `start_url` | String | Yes | — | Goodreads book reviews page URL to start collecting from. |
| `startUrls` | Array | No | `[]` | List of multiple Goodreads book review page URLs for bulk processing. |
| `results_wanted` | Integer | No | `20` | The maximum number of reviews to collect per book. |
| `maxConcurrency` | Integer | No | `2` | Maximum parallel instances for faster collection. |
| `debugLog` | Boolean | No | `false` | Enable detailed logging for troubleshooting. |
| `proxyConfiguration` | Object | No | `{"useApifyProxy": true, "apifyProxyGroups": ["RESIDENTIAL"]}` | Proxy settings (recommended for reliability). |

---

## Output Data

Each review item in the dataset contains:

| Field | Type | Description |
|-------|------|-------------|
| `reviewer_name` | String | The name of the person who wrote the review. |
| `rating` | Number | Star rating given (1 to 5). |
| `date` | String | The date the review was published. |
| `review_text` | String | The full content of the review. |
| `helpful_count` | Number | Number of likes/helpful votes. |
| `review_url` | String | Direct link to the specific review. |
| `book_url` | String | The URL of the book being reviews. |

---

## Usage Examples

### Basic Review Extraction

Collect the first 50 reviews for a specific book:

```json
{
    "start_url": "https://www.goodreads.com/book/show/2767052-the-catcher-in-the-rye/reviews",
    "results_wanted": 50
}
```

### Bulk Collection

Gather reviews for multiple books simultaneously:

```json
{
    "startUrls": [
        "https://www.goodreads.com/book/show/2767052-the-catcher-in-the-rye/reviews",
        "https://www.goodreads.com/book/show/1/reviews"
    ],
    "results_wanted": 100
}
```

### High-Volume Analysis

Large scale extraction using enhanced proxy settings for maximum reliability:

```json
{
    "start_url": "https://www.goodreads.com/book/show/4671-the-great-gatsby/reviews",
    "results_wanted": 1000,
    "proxyConfiguration": {
        "useApifyProxy": true,
        "apifyProxyGroups": ["RESIDENTIAL"]
    }
}
```

---

## Sample Output

```json
{
    "reviewer_name": "Alexander",
    "rating": 5,
    "date": "Jan 15, 2024",
    "review_text": "One of the most important books I have ever read. The character development is unparalleled and the themes remain timeless even decades later.",
    "review_url": "https://www.goodreads.com/review/show/123456789",
    "book_url": "https://www.goodreads.com/book/show/2767052-the-catcher-in-the-rye/reviews"
}
```

---

## Tips for Best Results

### Use High-Quality Proxies
- Residential proxies are strongly recommended to ensure continuous data collection without interruptions.
- These help maintain high success rates when collecting large volumes of data.

### Test with Small Samples
- Start with a small `results_wanted` (e.g., 20) to verify you are getting the data you need before running large jobs.
- Adjust your parameters based on the initial output quality.

### Manage Concurrency
- Keep concurrency low (1-3) for the most reliable results.
- Higher concurrency can be used for bulk tasks but monitor for any reduction in data quality.

---

## Integrations

Connect your Goodreads data with your favorite tools:

- **Google Sheets** — Export directly to spreadsheets for easy analysis.
- **Airtable** — Build a searchable database of book reviews.
- **Slack** — Get real-time notifications for new reviews.
- **Webhooks** — Automate workflows by sending data to custom endpoints.
- **Make/Zapier** — Create complex automations with external apps.

### Export Formats

- **JSON** — Ready for developers and application use.
- **CSV** — Ideal for Excel and manual analysis.
- **Excel** — Professional business reporting format.
- **XML** — For legacy system compatibility.

---

## Frequently Asked Questions

### How many reviews can I collect?
You can collect as many reviews as are publicly available. For books with thousands of reviews, be sure to use residential proxies for broad extraction.

### Can I collect data for multiple books?
Yes, use the `startUrls` parameter to provide a list of different books to scrape in a single run.

### Is the review text complete?
Yes, the scraper is designed to capture the full text of reviews, including longer entries that may be truncated on the initial page view.

### Do I need to be logged in?
No, this scraper works on publicly available data and does not require a Goodreads account or login credentials.

### What happens if a book has no reviews?
The actor will gracefully complete and an empty dataset or fewer results will be provided for that specific URL.

---

## Support

For issues, feature requests, or custom scraping needs, please contact support through the Apify Console.

### Resources

- [Apify Documentation](https://docs.apify.com/)
- [API Reference](https://docs.apify.com/api/v2)
- [How Scheduling Works](https://docs.apify.com/schedules)

---

## Legal Notice

This tool is designed for research and legitimate data collection purposes. Users are responsible for ensuring their data collection activities comply with the target website's terms of service and relevant local laws.