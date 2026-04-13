import React, { useEffect, useState } from 'react';
import { XMLParser } from 'fast-xml-parser';
import { ChatGoogle } from '@langchain/google';

const PAGE_ID = process.env.REACT_APP_FACEBOOK_PAGE_ID;
const ACCESS_TOKEN = process.env.REACT_APP_FACEBOOK_ACCESS_TOKEN;

const llm = new ChatGoogle({
  apiKey: process.env.REACT_APP_GOOGLE_API_KEY,
  model: "gemini-2.5-flash",
  temperature: 0.7,
  maxOutputTokens: 1024,
}).bindTools([{ googleSearch: {} }]);

function decodeGoogleNewsUrl(googleUrl) {
  try {
    const match = googleUrl.match(/articles\/([a-zA-Z0-9_-]+)/);
    if (!match) return googleUrl;
    const decoded = atob(match[1].replace(/-/g, '+').replace(/_/g, '/'));
    const urlStart = decoded.indexOf('http');
    if (urlStart === -1) return googleUrl;
    let urlEnd = urlStart;
    while (urlEnd < decoded.length && decoded.charCodeAt(urlEnd) >= 32) urlEnd++;
    return decoded.substring(urlStart, urlEnd);
  } catch {
    return googleUrl;
  }
}

const CORS_PROXIES = [
  (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
  (url) => `https://thingproxy.freeboard.io/fetch/${url}`,
];

export const MainPage = () => {
  const [newsList, setNewsList] = useState([]);
  const [loadingIndex, setLoadingIndex] = useState(null);

  useEffect(() => {
    async function getNews() {
      const topic = "AI news";
      const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&hl=en-US&gl=US&ceid=US:en`;
      let xml = null;

      for (const makeUrl of CORS_PROXIES) {
        try {
          const res = await fetch(makeUrl(rssUrl));
          if (!res.ok) continue;
          const text = await res.text();
          xml = text.trim().startsWith('{') ? JSON.parse(text).contents : text;
          if (xml?.includes('<rss')) break;
        } catch {
          continue;
        }
      }

      if (!xml) {
        console.error("All proxies failed");
        return;
      }

      const parser = new XMLParser({ ignoreAttributes: false, cdataPropName: "__cdata" });
      const parsed = parser.parse(xml);
      const items = (parsed?.rss?.channel?.item ?? []).slice(0, 10);

      setNewsList(items.map((item) => ({
        title: item.title?.__cdata || item.title,
        link: decodeGoogleNewsUrl(item.link),
        date: item.pubDate,
      })));
    }

    getNews();
  }, []);

  const postToFacebook = async (news, index) => {
    setLoadingIndex(index);
    try {
      const prompt = `Using Google Search, find the full article for this headline: "${news.title}".
      Write a Facebook post about it as if you are a human sharing news.
      Summarize the key points and then provide a 1 minute reading length. 
      No intro like "Here's a post", no markdown, no asterisks, no labels.
      Just write the post directly.`;

      const res = await llm.invoke(prompt);
      const message =
        res.text ||
        res.content?.filter((c) => c.type === "text")?.map((c) => c.text)?.join("") ||
        "";

      if (!message) {
        alert("Gemini returned empty content");
        return;
      }

      console.log("Generated message:", message);

      // 2. Post to Facebook — link included in body as fallback
      const postRes = await fetch(
        `https://graph.facebook.com/v19.0/${PAGE_ID}/feed`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: message,  
            access_token: ACCESS_TOKEN,
          }),
        }
      );

      const postData = await postRes.json();

      if (postData.error) {
        console.error("Facebook error:", postData.error);
        alert(`Facebook error: ${postData.error.message}`);
        return;
      }

      const postId = postData.id;

      // 3. Try to comment the link (requires pages_manage_engagement permission)
      try {
        const commentRes = await fetch(
          `https://graph.facebook.com/v19.0/${postId}/comments`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message: `🔗 Source: ${news.link}`,
              access_token: ACCESS_TOKEN,
            }),
          }
        );
        const commentData = await commentRes.json();
        if (commentData.error) {
          console.warn("Comment failed (add pages_manage_engagement permission):", commentData.error.message);
        }
      } catch (e) {
        console.warn("Could not post comment:", e);
      }

      alert("Posted to Facebook!");
    } catch (err) {
      console.error("Error:", err);
      alert("Failed to post");
    } finally {
      setLoadingIndex(null);
    }
  };

  return (
    <div style={{ padding: 20 }}>
      <h1>News</h1>
      {newsList.length === 0 && <p>Loading...</p>}
      {newsList.map((news, i) => (
        <div key={i} style={{ border: "1px solid #ccc", padding: 12, marginBottom: 12, borderRadius: 8 }}>
          <a href={news.link} target="_blank" rel="noreferrer">
            <strong>{news.title}</strong>
          </a>
          <p><small>{news.date}</small></p>
          <button
            onClick={() => postToFacebook(news, i)}
            disabled={loadingIndex === i}
            style={{
              padding: "8px 16px",
              cursor: loadingIndex === i ? "not-allowed" : "pointer",
              opacity: loadingIndex === i ? 0.6 : 1,
            }}
          >
            {loadingIndex === i ? "Posting..." : "Post to Facebook"}
          </button>
        </div>
      ))}
    </div>
  );
};