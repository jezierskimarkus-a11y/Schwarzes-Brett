from pathlib import Path
import json, requests
from bs4 import BeautifulSoup
from urllib.parse import urljoin, urlparse
URL="https://www.controlling.hhu.de/news/aktuelle-meldungen"
resp=requests.get(URL,timeout=30,headers={"User-Agent":"Mozilla/5.0 (compatible; HHU-Board-News/1.0)"});resp.raise_for_status()
soup = BeautifulSoup(resp.text, "html.parser")
n = []
seen = set()
# TYPO3 news list: articles, then title anchor. Refuse to replace old data on parse failure.
for article in soup.select(".news-list-view .article, .news-list-view article, .news-list-item, .news-list-view .news-item"):
    a=article.select_one("h2 a, h3 a, .header a, a[title]") or article.select_one("a[href]")
    if not a:continue
    url=urljoin(URL,a.get("href", "")); title=a.get_text(" ",strip=True)
    if urlparse(url).netloc!="www.controlling.hhu.de" or not title or url in seen:continue
    seen.add(url)
    dateEl=article.select_one("time, .news-list-date, .date")
    n.append({"date":dateEl.get_text(" ",strip=True)[:50] if dateEl else "HHU News", "title":title[:180], "url":url})
    if len(n)>=8:break
if len(n)<2:raise RuntimeError("News-Struktur nicht erkannt: bisherige news.json bleibt unverändert")
Path("news.json").write_text(json.dumps({"items":n},ensure_ascii=False,indent=2)+"\n")
print(f"{len(n)} HHU-News aktualisiert")
