package com.getnovels.crawl;

import jakarta.validation.constraints.NotBlank;

public record DownloadRequest(
    @NotBlank String url,
    String title,
    CrawlRequest.Credentials credentials
) {
}
