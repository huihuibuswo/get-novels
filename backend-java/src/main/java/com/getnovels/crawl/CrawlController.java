package com.getnovels.crawl;

import jakarta.validation.Valid;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.http.converter.HttpMessageConverter;
import org.springframework.http.converter.json.MappingJackson2HttpMessageConverter;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestClientResponseException;
import org.springframework.web.client.RestClient;
import java.util.ArrayList;
import java.util.List;

@RestController
@RequestMapping("/api")
public class CrawlController {
    private final RestClient restClient;

    public CrawlController(@Value("${crawler.base-url}") String crawlerBaseUrl) {
        List<HttpMessageConverter<?>> converters = new ArrayList<>();
        converters.add(new MappingJackson2HttpMessageConverter());

        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(5000);
        factory.setReadTimeout(60000); // 延长读取超时时间至 60 秒

        this.restClient = RestClient.builder()
            .requestFactory(factory)
            .baseUrl(crawlerBaseUrl)
            .messageConverters(converters)
            .build();
    }

    @PostMapping(value = "/index", consumes = MediaType.APPLICATION_JSON_VALUE, produces = MediaType.APPLICATION_JSON_VALUE)
    CrawlResponse index(@Valid @RequestBody CrawlRequest request) {
        return restClient.post()
            .uri("/index")
            .contentType(MediaType.APPLICATION_JSON)
            .body(request)
            .retrieve()
            .body(CrawlResponse.class);
    }

    @PostMapping(value = "/download", consumes = MediaType.APPLICATION_JSON_VALUE, produces = MediaType.APPLICATION_JSON_VALUE)
    DownloadResponse download(@Valid @RequestBody DownloadRequest request) {
        return restClient.post()
            .uri("/download")
            .contentType(MediaType.APPLICATION_JSON)
            .body(request)
            .retrieve()
            .body(DownloadResponse.class);
    }

    @ExceptionHandler(RestClientException.class)
    ResponseEntity<String> handleRestClientException(RestClientException e) {
        if (e instanceof RestClientResponseException re) {
            return ResponseEntity
                .status(re.getStatusCode())
                .contentType(MediaType.APPLICATION_JSON)
                .body(re.getResponseBodyAsString());
        }
        // 对于 Read Timeout、Connection Refused 等网络层异常，返回 502 并附带真实错误信息
        return ResponseEntity
            .status(502)
            .contentType(MediaType.APPLICATION_JSON)
            .body("{\"detail\":\"调用爬虫服务异常: " + e.getMessage() + "\"}");
    }
}
