package com.getnovels.crawl;

import java.util.List;

public record CrawlResponse(
    boolean requiresLogin,
    String loginUrl,
    int scannedPages,
    List<String> categories,
    List<NovelCandidate> novels
) {
    public record NovelCandidate(
        String title,
        String url,
        String category,
        List<String> tags,
        String description,
        int score,
        List<String> matchedKeywords,
        int wordCount,
        int textLength,
        int chapterHints
    ) {
    }
}
