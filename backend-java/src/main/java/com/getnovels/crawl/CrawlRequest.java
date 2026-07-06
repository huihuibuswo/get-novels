package com.getnovels.crawl;

import jakarta.validation.constraints.NotBlank;

public record CrawlRequest(
    @NotBlank String url,
    Credentials credentials
) {
    public record Credentials(String username, String password) {
    }
}
