import React, { useEffect, useState } from 'react';
import { XMLParser } from 'fast-xml-parser';
import { ChatGoogle } from '@langchain/google';

const topic = "Honkai Star Rail";
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

// Extract image URL from RSS description HTML
function extractImageFromDescription(description) {
  try {
    const match = description?.match(/<img[^>]+src="([^"]+)"/);
    return match ? match[1] : null;
  } catch {
    return null;
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

      if (!xml) { console.error("All proxies failed"); return; }

      const parser = new XMLParser({ ignoreAttributes: false, cdataPropName: "__cdata" });
      const parsed = parser.parse(xml);
      const items = (parsed?.rss?.channel?.item ?? []).slice(0, 10);

      setNewsList(items.map((item) => {
        const description = item.description?.__cdata || item.description || "";
        const image = extractImageFromDescription(description);
        console.log("Image found:", image); // check if images are being extracted

        return {
          title: item.title?.__cdata || item.title,
          link: decodeGoogleNewsUrl(item.link),
          date: item.pubDate,
          image,
        };
      }));
    }

    getNews();
  }, []);

  const postToFacebook = async (news, index) => {
    setLoadingIndex(index);
    try {
      // 1. Generate post text + find image with Gemini in one call
      const prompt = `Using Google Search, find the full article for this headline: "${news.title}".

      Do two things:
      1. Write a Facebook post about it as if you are a human sharing news. 1 minute reading length. No intro, no markdown, no asterisks, no labels. Just the post text.
      2. Find a relevant publicly accessible image URL from the article or from Google Images related to this topic.

      Respond in this exact JSON format only, no other text:
      {
        "message": "the facebook post text here",
        "imageUrl": "https://... or null if not found"
      }`;

      const res = await llm.invoke(prompt);
      const raw =
        res.text ||
        res.content?.filter((c) => c.type === "text")?.map((c) => c.text)?.join("") ||
        "";

      console.log("Gemini raw response:", raw);

      // Parse JSON from Gemini response
      let message = "";
      let imageUrl = null;
      try {
        const clean = raw.replace(/```json|```/g, "").trim();
        const parsed = JSON.parse(clean);
        message = parsed.message;
        imageUrl = parsed.imageUrl !== "null" ? parsed.imageUrl : null;
      } catch {
        // If Gemini didn't return JSON, use raw as message
        message = raw;
      }

      console.log("Message:", message);
      console.log("Image URL:", imageUrl);

      if (!message) { alert("Gemini returned empty content"); return; }

      let postId;

      if (imageUrl) {
        // Post with photo
        const photoRes = await fetch(
          `https://graph.facebook.com/v19.0/${PAGE_ID}/photos`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              caption: message,
              url: imageUrl,
              access_token: ACCESS_TOKEN,
            }),
          }
        );
        const photoData = await photoRes.json();
        console.log("Photo post response:", photoData);

        if (photoData.error) {
          console.warn("Photo failed, falling back to text:", photoData.error.message);
          // Fallback to text only
          const fallbackRes = await fetch(
            `https://graph.facebook.com/v19.0/${PAGE_ID}/feed`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ message, access_token: ACCESS_TOKEN }),
            }
          );
          const fallbackData = await fallbackRes.json();
          postId = fallbackData.id;
        } else {
          postId = photoData.post_id;
        }
      } else {
        // Text only
        const postRes = await fetch(
          `https://graph.facebook.com/v19.0/${PAGE_ID}/feed`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message, access_token: ACCESS_TOKEN }),
          }
        );
        const postData = await postRes.json();
        if (postData.error) {
          console.error("Facebook error:", postData.error);
          alert(`Facebook error: ${postData.error.message}`);
          return;
        }
        postId = postData.id;
      }

      // Comment the source link
      if (postId) {
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
            console.warn("Comment failed:", commentData.error.message);
          }
        } catch (e) {
          console.warn("Could not post comment:", e);
        }
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
          {news.image && (
            <img
              src={news.image}
              alt={news.title}
              style={{ width: "100%", maxHeight: 200, objectFit: "cover", borderRadius: 6, marginBottom: 8 }}
            />
          )}
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