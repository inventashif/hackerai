import unittest
from urllib.parse import parse_qs, urlsplit
from search_urls import search_url


class SearchUrlTests(unittest.TestCase):
    def test_https_and_exact_host(self):
        url = urlsplit(search_url("idor export"))
        self.assertEqual((url.scheme, url.netloc, url.path), ("https", "bugbountyhunting.com", "/"))
        self.assertEqual(parse_qs(url.query), {"q": ["idor export"]})

    def test_query_delimiters_and_unicode_are_encoded(self):
        keywords = "oauth & redirect#?= café"
        self.assertEqual(parse_qs(urlsplit(search_url(keywords)).query), {"q": [keywords]})

    def test_empty_oversized_and_control_characters_rejected(self):
        for keywords in ("", "   ", "x" * 201, "a\nb", "a\x00b", "a\x7fb"):
            with self.subTest(keywords=repr(keywords)):
                with self.assertRaises(ValueError):
                    search_url(keywords)

    def test_trims_padding(self):
        self.assertEqual(search_url("  ssrf  "), "https://bugbountyhunting.com/?q=ssrf")


if __name__ == "__main__":
    unittest.main()
