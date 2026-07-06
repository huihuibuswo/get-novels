package com.getnovels.crawl;

public record DownloadResponse(
    String title,
    String filename,
    String content,
    int chapterCount
) {
}
