import unittest
from unittest.mock import patch

import main
from bs4 import BeautifulSoup


class NovelSearchTests(unittest.TestCase):
    def test_extracts_clean_title_from_search_heading(self):
        query = "诡秘之主"
        heading = "诡秘之主（爱潜水的乌贼创作的长篇小说）_百度百科"
        self.assertEqual(main.extract_search_novel_title(heading, query), query)

    def test_collapses_search_marketing_suffixes_into_same_novel(self):
        query = "一枚小软糖"
        self.assertEqual(main.extract_search_novel_title("一枚小软糖小说无删减txt最新章节", query), query)
        self.assertEqual(main.extract_search_novel_title("一枚小软糖 小说阅读", query), query)

    def test_fuzzy_match_rewards_containment(self):
        self.assertGreaterEqual(main.fuzzy_match_score("诡秘", "诡秘之主"), 70)
        self.assertLess(main.fuzzy_match_score("诡秘", "三体"), 55)

    def test_short_result_fragment_does_not_match_full_title(self):
        self.assertLess(main.fuzzy_match_score("一枚小软糖", "一枚"), 55)
        self.assertLess(main.fuzzy_match_score("一枚小软糖", "枚"), 55)

    @patch("main.web_search")
    def test_search_groups_same_novel_from_multiple_sites(self, web_search):
        web_search.return_value = [
            ("诡秘之主（网络小说）_百科", "https://example.com/a", "简介一"),
            ("《诡秘之主》最新章节", "https://example.org/b", "更完整的小说简介"),
            ("完全无关的结果", "https://example.net/c", "无关"),
        ]

        response = main.search_novels(main.NovelSearchRequest(query="诡秘之主"))

        self.assertEqual(len(response.novels), 1)
        self.assertEqual(response.novels[0].title, "诡秘之主")
        self.assertEqual(response.novels[0].sourceCount, 2)
        self.assertEqual(response.novels[0].matchScore, 100)

    def test_search_input_is_bounded(self):
        with self.assertRaises(Exception):
            main.normalize_search_text("x" * 81, "小说名称")

    def test_source_validation_rejects_video_episode_links(self):
        soup = BeautifulSoup(
            '<a href="/video/1">第1集</a><a href="/book/1/chapter1.html">第一章 开端</a>',
            "html.parser",
        )
        links = main.extract_strong_chapter_links("https://example.com/book/1", soup, "example.com")
        self.assertEqual(links, ["https://example.com/book/1/chapter1.html"])

    def test_rejects_search_pages_as_download_sources(self):
        self.assertTrue(main.is_search_result_url("https://example.com/bookquery/abc"))
        self.assertTrue(main.is_search_result_url("https://example.com/search?q=book"))
        self.assertFalse(main.is_search_result_url("https://example.com/book/123"))

    def test_rejects_incomplete_download(self):
        with self.assertRaises(main.HTTPException) as context:
            main.validate_download_completeness(chapter_count=1, expected_chapter_count=58)
        self.assertIn("下载不完整", context.exception.detail)

    def test_accepts_download_close_to_discovered_chapter_count(self):
        main.validate_download_completeness(chapter_count=53, expected_chapter_count=58)

    def test_extracts_deduplicates_and_orders_chapter_catalog(self):
        soup = BeautifulSoup('''<div class="listmain">
          <a href="/c3">第3章 结尾</a><a href="/c2">第2章 继续</a>
          <a href="/c1">第1章 开始</a><a href="/c2">第2章 继续</a>
        </div>''', "html.parser")
        chapters = main.extract_chapter_entries("https://example.com/book", soup, "example.com")
        self.assertEqual([chapter.title for chapter in chapters], ["第1章 开始", "第2章 继续", "第3章 结尾"])

    def test_selected_chapters_must_stay_on_source_host(self):
        with self.assertRaises(main.HTTPException):
            main.validate_selected_chapter_urls(
                "https://example.com/book",
                ["https://evil.example/chapter/1"],
            )

    @patch("main.duckduckgo_html_search")
    @patch("main.bing_rss_search")
    def test_uses_duckduckgo_when_bing_fails(self, bing_search, duckduckgo_search):
        bing_search.side_effect = main.HTTPException(status_code=502, detail="Bing failed")
        duckduckgo_search.return_value = [("结果", "https://example.com/book", "简介")]

        self.assertEqual(main.web_search("书名"), duckduckgo_search.return_value)
        duckduckgo_search.assert_called_once_with("书名")

    @patch("main.duckduckgo_html_search")
    @patch("main.bing_rss_search")
    def test_uses_duckduckgo_when_bing_results_are_irrelevant(self, bing_search, duckduckgo_search):
        bing_search.return_value = [
            ("一枚的意思_一枚的解释", "https://example.com/dictionary", "词语解释"),
            ("枚（汉语文字）", "https://example.com/wiki", "汉字解释"),
        ]
        duckduckgo_search.return_value = [
            ("一枚小软糖 (三月棠墨)小说在线阅读", "https://example.com/book", "小说简介"),
        ]

        results = main.web_search('"一枚小软糖" 小说', relevance_query="一枚小软糖")

        self.assertEqual(results, duckduckgo_search.return_value)
        duckduckgo_search.assert_called_once()

    @patch("main.request_duckduckgo_provider")
    def test_parses_duckduckgo_html_and_unwraps_redirect(self, request_provider):
        html = '''<div class="result">
          <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fbook">Book title</a>
          <a class="result__snippet">Book description</a>
        </div>'''
        request_provider.return_value = ("https://html.duckduckgo.com/html/?q=book", html)

        results = main.duckduckgo_html_search("book")

        self.assertEqual(results, [("Book title", "https://example.com/book", "Book description")])


if __name__ == "__main__":
    unittest.main()
