#!/usr/bin/env python3
"""Offline URL builder: no HTTP, target probing, credentials or PoC execution."""
import argparse
from urllib.parse import quote


def search_url(keywords: str) -> str:
    if not isinstance(keywords, str):
        raise ValueError("Keywords must be text")
    if any(ord(char) < 32 or ord(char) == 127 for char in keywords):
        raise ValueError("Control characters are not allowed")
    keywords = keywords.strip()
    if not keywords or len(keywords) > 200:
        raise ValueError("Use 1–200 characters of generic technical keywords")
    return "https://bugbountyhunting.com/?q=" + quote(keywords, safe="")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("keywords", help="Generic scenario keywords; never include secrets or private target data")
    args = parser.parse_args()
    try:
        print(search_url(args.keywords))
    except ValueError as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
