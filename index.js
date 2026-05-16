import express from "express";
import cors from "cors";
import { Readable } from "node:stream";
import { Innertube, UniversalCache, Platform, YTNodes, Parser, SectionListContinuation } from "youtubei.js";

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(express.static("."));

Platform.shim.eval = async (data, env) => {
  const props = [];
  if (env.n) props.push(`n: exportedVars.nFunction("${env.n}")`);
  if (env.sig) props.push(`sig: exportedVars.sigFunction("${env.sig}")`);
  return new Function(`${data.output}\nreturn { ${props.join(", ")} };`)();
};

const youtube = await Innertube.create({
  lang: "es",
  location: "MX",
  retrieve_player: true,
  cache: new UniversalCache(false),
});

function thumbnailArray(thumb) {
  if (!thumb) return null;
  if (Array.isArray(thumb)) return thumb;
  if (Array.isArray(thumb.contents)) return thumb.contents;
  if (typeof thumb.thumbnails === "function") return thumb.thumbnails();
  if (Array.isArray(thumb.thumbnails)) return thumb.thumbnails;
  return null;
}

function pickThumbnail(thumb) {
  const arr = thumbnailArray(thumb);
  if (!arr || arr.length === 0) return null;
  return [...arr].sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url ?? null;
}

function pickThumbnailRatio(thumb) {
  const arr = thumbnailArray(thumb);
  if (!arr || arr.length === 0) return null;
  const big = [...arr].sort((a, b) => (b.width || 0) - (a.width || 0))[0];
  if (!big?.width || !big?.height) return null;
  return +(big.width / big.height).toFixed(3);
}

function textToString(t) {
  if (!t) return "";
  if (typeof t === "string") return t;
  if (typeof t.toString === "function") return t.toString();
  return String(t);
}

function extractEndpoint(ep) {
  if (!ep) return null;
  const payload = ep.payload ?? {};
  return {
    browse_id: payload.browseId ?? null,
    params: payload.params ?? null,
    video_id: payload.videoId ?? null,
    playlist_id: payload.playlistId ?? null,
    page_type: ep.metadata?.page_type ?? null,
    url: ep.metadata?.url ?? null,
  };
}

function normalizeItem(item) {
  if (!item) return null;
  const t = item.type;

  if (t === "MusicTwoRowItem") {
    return {
      kind: item.item_type ?? "unknown",
      title: textToString(item.title),
      subtitle: textToString(item.subtitle),
      thumbnail: pickThumbnail(item.thumbnail),
      thumbnail_ratio: pickThumbnailRatio(item.thumbnail),
      endpoint: extractEndpoint(item.endpoint),
      artists: (item.artists ?? []).map((a) => ({
        name: a.name,
        channel_id: a.channel_id ?? null,
      })),
      year: item.year ?? null,
      views: item.views ?? null,
      subscribers: item.subscribers ?? null,
      item_count: item.item_count ?? null,
    };
  }

  if (t === "MusicResponsiveListItem") {
    const flexSubtitle = textToString(item.flex_columns?.[1]?.title);
    const people = (item.artists?.length ? item.artists : item.authors) ?? [];
    return {
      kind: item.item_type ?? "unknown",
      title: textToString(item.title ?? item.flex_columns?.[0]?.title),
      subtitle: textToString(item.subtitle) || flexSubtitle,
      thumbnail: pickThumbnail(item.thumbnails ?? item.thumbnail),
      thumbnail_ratio: pickThumbnailRatio(item.thumbnails ?? item.thumbnail),
      endpoint: extractEndpoint(item.endpoint) ?? (item.id ? { video_id: item.id, browse_id: null, params: null, playlist_id: null, page_type: null, url: null } : null),
      artists: people.map((a) => ({
        name: a.name,
        channel_id: a.channel_id ?? null,
      })),
      album: item.album?.name ?? null,
      duration: item.duration?.text ?? null,
      views: typeof item.views === "string" ? item.views : null,
      year: item.year ?? null,
    };
  }

  if (t === "MusicMultiRowListItem") {
    return {
      kind: "multi_row",
      title: textToString(item.title),
      subtitle: textToString(item.subtitle),
      description: textToString(item.description),
      thumbnail: pickThumbnail(item.thumbnail),
      thumbnail_ratio: pickThumbnailRatio(item.thumbnail),
      endpoint: extractEndpoint(item.on_tap),
    };
  }

  if (t === "MusicNavigationButton") {
    return {
      kind: "button",
      title: textToString(item.button_text),
      color: null,
      endpoint: extractEndpoint(item.endpoint),
    };
  }

  return null;
}

function normalizeShelf(shelf) {
  if (!shelf) return null;
  const t = shelf.type;

  if (t === "MusicCarouselShelf") {
    const header = shelf.header;
    const items = (shelf.contents ?? []).map(normalizeItem).filter(Boolean);
    const allButtons = items.length > 0 && items.every((i) => i.kind === "button");
    return {
      type: allButtons ? "button_carousel" : "carousel",
      title: textToString(header?.title),
      strapline: textToString(header?.strapline),
      thumbnail: pickThumbnail(header?.thumbnail),
      items,
    };
  }

  if (t === "MusicDescriptionShelf") {
    return {
      type: "description",
      title: textToString(shelf.header),
      description: textToString(shelf.description),
      footer: textToString(shelf.footer),
    };
  }

  if (t === "MusicTastebuilderShelf") {
    return {
      type: "tastebuilder",
      title: textToString(shelf.title),
      subtitle: textToString(shelf.subtitle),
      thumbnail: pickThumbnail(shelf.thumbnail),
    };
  }

  if (t === "MusicShelf") {
    return {
      type: "list",
      title: textToString(shelf.title),
      items: (shelf.contents ?? []).map(normalizeItem).filter(Boolean),
    };
  }

  if (t === "Grid") {
    const items = (shelf.items ?? []).map(normalizeItem).filter(Boolean);
    const allButtons = items.length > 0 && items.every((i) => i.kind === "button");
    return {
      type: allButtons ? "button_carousel" : "grid",
      title: textToString(shelf.header?.title),
      items,
    };
  }

  return null;
}

function colorIntToHex(value) {
  if (value === null || value === undefined) return null;
  return `#${(value >>> 0).toString(16).slice(-6).padStart(6, "0")}`;
}

function extractButtonColorsFromRaw(rawData) {
  const map = new Map();
  const tabs = rawData?.contents?.singleColumnBrowseResultsRenderer?.tabs ?? [];
  const tab =
    tabs.find((t) => t.tabRenderer?.selected)?.tabRenderer ??
    tabs[0]?.tabRenderer;
  const sections = tab?.content?.sectionListRenderer?.contents ?? [];

  for (const section of sections) {
    const carousel = section?.musicCarouselShelfRenderer;
    const grid = section?.gridRenderer;
    const container = carousel ?? grid;
    if (!container) continue;

    const titleNode =
      carousel?.header?.musicCarouselShelfBasicHeaderRenderer?.title ??
      grid?.header?.gridHeaderRenderer?.title;
    const title =
      titleNode?.runs?.map((r) => r.text).join("") ??
      titleNode?.simpleText ??
      "";

    const items = carousel?.contents ?? grid?.items ?? [];
    const colorByText = new Map();
    for (const item of items) {
      const btn = item?.musicNavigationButtonRenderer;
      if (!btn) continue;
      const text =
        btn.buttonText?.runs?.map((r) => r.text).join("") ??
        btn.buttonText?.simpleText ??
        "";
      const solid = btn.solid?.leftStripeColor ?? null;
      const stripe =
        btn.iconStyle?.icon?.stripeColor ??
        btn.iconStyle?.icon?.iconColor ??
        null;
      const color = colorIntToHex(solid ?? stripe ?? null);
      if (text) colorByText.set(text, color);
    }
    if (colorByText.size > 0) map.set(title, colorByText);
  }

  return map;
}

function applyButtonColors(sections, colorMap) {
  for (const shelf of sections) {
    if (shelf.type !== "button_carousel") continue;
    const colors = colorMap.get(shelf.title || "");
    if (!colors) continue;
    for (const item of shelf.items) {
      if (item.color) continue;
      const c = colors.get(item.title);
      if (c) item.color = c;
    }
  }
}

function extractBackground(rawData) {
  const thumbs =
    rawData?.background?.musicThumbnailRenderer?.thumbnail?.thumbnails ?? null;
  if (!Array.isArray(thumbs) || thumbs.length === 0) return null;
  return [...thumbs].sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url ?? null;
}

const MAX_CONTINUATION_ROUNDS = 8;

async function fetchAllContinuations(initialContinuation, accumulator) {
  let token = initialContinuation;
  let round = 0;
  while (token && round < MAX_CONTINUATION_ROUNDS) {
    round += 1;
    const resp = await youtube.actions.execute("/browse", {
      client: "YTMUSIC",
      continuation: token,
    });
    const parsedCont = Parser.parseResponse(resp.data);
    const cont = parsedCont.continuation_contents;
    if (!cont) break;
    const sectionCont = cont.is(SectionListContinuation)
      ? cont
      : cont.as(SectionListContinuation);
    const newSections = (sectionCont.contents ?? [])
      .map(normalizeShelf)
      .filter(Boolean);
    accumulator.push(...newSections);
    token = sectionCont.continuation ?? null;
  }
}

function extractHeaderInfo(parsed, rawData) {
  const headerNode = parsed.header?.item?.();
  const info = { title: "", subtitle: "", description: "", thumbnail: null };
  if (!headerNode) return info;

  if (headerNode.is(YTNodes.MusicHeader)) {
    info.title = textToString(headerNode.title);
  } else if (headerNode.is(YTNodes.MusicResponsiveHeader)) {
    info.title = textToString(headerNode.title);
    info.subtitle = textToString(headerNode.subtitle);
    info.description = textToString(headerNode.description);
    info.thumbnail = pickThumbnail(headerNode.thumbnail);
  } else if (headerNode.is(YTNodes.MusicDetailHeader)) {
    info.title = textToString(headerNode.title);
    info.subtitle = textToString(headerNode.subtitle);
    info.thumbnail = pickThumbnail(headerNode.thumbnail);
  } else if (headerNode.is(YTNodes.MusicVisualHeader)) {
    info.title = textToString(headerNode.title);
    info.thumbnail = pickThumbnail(
      headerNode.foreground_thumbnail ?? headerNode.thumbnail
    );
  } else if (headerNode.is(YTNodes.MusicImmersiveHeader)) {
    info.title = textToString(headerNode.title);
    const rawThumb =
      rawData?.header?.musicImmersiveHeaderRenderer?.thumbnail
        ?.musicThumbnailRenderer?.thumbnail?.thumbnails ?? null;
    if (Array.isArray(rawThumb) && rawThumb.length > 0) {
      info.thumbnail =
        [...rawThumb].sort((a, b) => (b.width || 0) - (a.width || 0))[0]
          ?.url ?? null;
    }
  }
  return info;
}

async function fetchPage({ browseId, params, includeChips = false, includeBackground = false }) {
  const response = await youtube.actions.execute("/browse", {
    browseId,
    ...(params ? { params } : {}),
    client: "YTMUSIC",
  });
  const rawData = response?.data ?? response;
  const parsed = Parser.parseResponse(rawData);

  const headerInfo = extractHeaderInfo(parsed, rawData);
  const background = includeBackground ? extractBackground(rawData) : null;

  let chips = [];
  let sections = [];
  let continuationToken = null;

  const tabs = parsed.contents
    ?.item()
    ?.as(YTNodes.SingleColumnBrowseResults)
    ?.tabs;
  const tab = tabs?.find((tb) => tb.selected) ?? tabs?.[0];

  if (tab?.content) {
    const sectionList = tab.content.as(YTNodes.SectionList);
    continuationToken = sectionList.continuation ?? null;

    if (includeChips) {
      const chipCloud = sectionList.header?.is?.(YTNodes.ChipCloud)
        ? sectionList.header
        : null;
      if (chipCloud) {
        chips = (chipCloud.chips?.as(YTNodes.ChipCloudChip) ?? []).map((chip) => ({
          text: chip.text ?? "",
          is_selected: chip.is_selected ?? false,
          params: chip.endpoint?.payload?.params ?? null,
        }));
      }
    }

    sections = (sectionList.contents ?? [])
      .map(normalizeShelf)
      .filter(Boolean);
  }

  await fetchAllContinuations(continuationToken, sections);

  const colorMap = extractButtonColorsFromRaw(rawData);
  if (colorMap.size > 0) applyButtonColors(sections, colorMap);

  return { headerInfo, chips, sections, background };
}

app.get("/", (_req, res) => {
  res.json({ status: "ok", message: "YouTube.js API is running" });
});

// ─── Home ─────────────────────────────────────────────────────────────────────
app.get("/api/home", async (_req, res) => {
  try {
    const { chips, sections, background } = await fetchPage({
      browseId: "FEmusic_home",
      includeChips: true,
      includeBackground: true,
    });
    res.json({ chips, sections, background });
  } catch (error) {
    console.error("[/api/home] error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/home/filter", async (req, res) => {
  try {
    const { params } = req.query;
    const { chips, sections, background } = await fetchPage({
      browseId: "FEmusic_home",
      params,
      includeChips: true,
      includeBackground: true,
    });
    res.json({ chips, sections, background });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Explore ──────────────────────────────────────────────────────────────────
const TOP_BUTTON_ICONS = {
  FEmusic_new_releases: "new_releases",
  FEmusic_charts: "trending",
  FEmusic_moods_and_genres: "palette",
  FEmusic_non_music_audio: "podcast",
};

const exploreCache = { at: 0, data: null };
const EXPLORE_TTL_MS = 5 * 60 * 1000;

async function buildExplore() {
  const explore = await youtube.music.getExplore();
  const top_buttons = (explore.top_buttons ?? []).map((btn) => {
    const endpoint = extractEndpoint(btn.endpoint);
    return {
      text: textToString(btn.button_text),
      icon: endpoint?.browse_id ? TOP_BUTTON_ICONS[endpoint.browse_id] ?? null : null,
      endpoint,
    };
  });

  const previewBrowseIds = [
    { browseId: "FEmusic_new_releases", strapline: "Novedades", limit: 2 },
    { browseId: "FEmusic_charts", strapline: "Listas de éxitos", limit: 2 },
    { browseId: "FEmusic_non_music_audio", strapline: "Pódcasts", limit: 2 },
  ];

  const [exploreResult, ...previewResults] = await Promise.all([
    fetchPage({ browseId: "FEmusic_explore" }),
    ...previewBrowseIds.map((p) =>
      fetchPage({ browseId: p.browseId }).catch(() => ({ sections: [] })),
    ),
  ]);

  const baseSections = exploreResult.sections.filter((s) => {
    if (!s.title && s.type === "button_carousel") return false;
    return true;
  });

  const seenTitles = new Set(baseSections.map((s) => s.title));
  const extras = [];
  previewBrowseIds.forEach((cfg, idx) => {
    const result = previewResults[idx];
    if (!result?.sections?.length) return;
    const carousels = result.sections
      .filter((s) => (s.type === "carousel" || s.type === "list") && (s.items?.length ?? 0) > 0)
      .slice(0, cfg.limit);
    for (const c of carousels) {
      if (seenTitles.has(c.title)) continue;
      seenTitles.add(c.title);
      extras.push({ ...c, strapline: cfg.strapline });
    }
  });

  const ordered = [];
  const buttonShelf = baseSections.find((s) => s.type === "button_carousel");
  if (buttonShelf) ordered.push(buttonShelf);
  for (const s of baseSections) if (s !== buttonShelf) ordered.push(s);
  ordered.push(...extras);

  return { top_buttons, sections: ordered };
}

app.get("/api/explore", async (_req, res) => {
  try {
    const now = Date.now();
    if (!exploreCache.data || now - exploreCache.at > EXPLORE_TTL_MS) {
      exploreCache.data = await buildExplore();
      exploreCache.at = now;
    }
    res.json(exploreCache.data);
  } catch (error) {
    console.error("[/api/explore] error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Moods & Genres ───────────────────────────────────────────────────────────
app.get("/api/moods_and_genres", async (_req, res) => {
  try {
    const response = await youtube.actions.execute("/browse", {
      browseId: "FEmusic_moods_and_genres",
      client: "YTMUSIC",
    });

    const raw = response?.data ?? response;
    const tabs =
      raw?.contents?.singleColumnBrowseResultsRenderer?.tabs ?? [];
    const tab =
      tabs.find((t) => t.tabRenderer?.selected)?.tabRenderer ??
      tabs[0]?.tabRenderer;
    const sectionList =
      tab?.content?.sectionListRenderer?.contents ?? [];

    const sections = [];
    for (const section of sectionList) {
      const grid = section?.gridRenderer;
      if (!grid) continue;

      const title =
        grid.header?.gridHeaderRenderer?.title?.runs?.map((r) => r.text).join("") ??
        grid.header?.gridHeaderRenderer?.title?.simpleText ??
        "";

      const items = grid.items ?? [];
      const buttons = [];
      for (const item of items) {
        const btn = item?.musicNavigationButtonRenderer;
        if (!btn) continue;

        const text =
          btn.buttonText?.runs?.map((r) => r.text).join("") ??
          btn.buttonText?.simpleText ??
          "";

        const solid = btn.solid?.leftStripeColor ?? null;
        const stripe =
          btn.iconStyle?.icon?.stripeColor ??
          btn.iconStyle?.icon?.iconColor ??
          null;
        const browse = btn.clickCommand?.browseEndpoint ?? null;

        buttons.push({
          text,
          color: colorIntToHex(solid ?? stripe ?? null),
          params: browse?.params ?? null,
          browse_id: browse?.browseId ?? null,
        });
      }

      if (buttons.length > 0) sections.push({ title, buttons });
    }

    res.json({ sections });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Browse ───────────────────────────────────────────────────────────────────
async function fetchPlaylist(browseId) {
  const plId = browseId.startsWith("VL") ? browseId.slice(2) : browseId;
  const pl = await youtube.music.getPlaylist(plId);
  const hdr = pl.header;
  const headerInfo = {
    title: textToString(hdr?.title),
    subtitle: [textToString(hdr?.subtitle), textToString(hdr?.second_subtitle)]
      .filter(Boolean)
      .join(" • "),
    description: "",
    thumbnail: pickThumbnail(hdr?.thumbnail),
  };
  const tracks = (pl.contents ?? []).map(normalizeItem).filter(Boolean);
  return {
    headerInfo,
    sections: tracks.length ? [{ type: "list", title: "", items: tracks }] : [],
  };
}

app.get("/api/browse", async (req, res) => {
  try {
    const { browse_id, params } = req.query;
    if (!browse_id) {
      return res.status(400).json({ error: "browse_id es requerido" });
    }
    if (browse_id.startsWith("VL")) {
      const { headerInfo, sections } = await fetchPlaylist(browse_id);
      return res.json({ ...headerInfo, sections });
    }
    const { headerInfo, sections } = await fetchPage({
      browseId: browse_id,
      params,
    });
    res.json({ ...headerInfo, sections });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Stream ───────────────────────────────────────────────────────────────────
const YT_STREAM_HEADERS = {
  accept: "*/*",
  origin: "https://www.youtube.com",
  referer: "https://www.youtube.com",
  DNT: "?1",
};
const CHUNK_SIZE = 524288;
const IOS_USER_AGENT = "com.google.ios.youtube/20.11.6 (iPhone10,4; U; CPU iOS 16_7_7 like Mac OS X)";
const streamCache = new Map();

app.get("/api/stream", async (req, res) => {
  try {
    const { video_id } = req.query;
    if (!video_id) return res.status(400).json({ error: "video_id requerido" });

    let streamData = streamCache.get(video_id);

    if (!streamData) {
      const info = await youtube.getBasicInfo(video_id, { client: "IOS" });
      const status = info.playability_status?.status;
      if (status !== "OK") {
        return res.status(403).json({ error: info.playability_status?.reason ?? status });
      }

      const fmt = (info.streaming_data?.adaptive_formats ?? [])
        .filter((f) => f.has_audio && !f.has_video && f.url && !f.signature_cipher && !f.cipher)
        .sort((a, b) => b.bitrate - a.bitrate)[0];

      if (!fmt?.url) return res.status(404).json({ error: "Sin formato de audio" });

      streamData = {
        url: fmt.url,
        mimeType: fmt.mime_type?.split(";")[0]?.trim() ?? "audio/mp4",
        totalSize: Number(fmt.content_length ?? 0),
      };

      streamCache.set(video_id, streamData);
      setTimeout(() => streamCache.delete(video_id), 3 * 60 * 60 * 1000);
    }

    const { url: fmtUrl, mimeType, totalSize } = streamData;

    const clientRange = req.headers["range"];
    let start = 0;
    let end;
    if (clientRange) {
      const m = clientRange.match(/bytes=(\d+)-(\d*)/);
      if (m) {
        start = parseInt(m[1]);
        end = m[2] ? parseInt(m[2]) : start + CHUNK_SIZE - 1;
      }
    }
    if (end === undefined) end = start + CHUNK_SIZE - 1;
    if (totalSize) end = Math.min(end, totalSize - 1);

    const upstream = await fetch(fmtUrl, {
      headers: {
        ...YT_STREAM_HEADERS,
        "User-Agent": IOS_USER_AGENT,
        Range: `bytes=${start}-${end}`,
      },
    });

    if (!upstream.ok) {
      if (upstream.status === 403) streamCache.delete(video_id);
      return res.status(upstream.status).json({ error: "Error al obtener audio" });
    }

    const upstreamLen = parseInt(upstream.headers.get("content-length") ?? "0");
    const actualEnd = upstreamLen ? start + upstreamLen - 1 : end;

    res.status(206);
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Accept-Ranges", "bytes");
    if (upstreamLen) res.setHeader("Content-Length", upstreamLen);
    if (totalSize) res.setHeader("Content-Range", `bytes ${start}-${actualEnd}/${totalSize}`);
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

app.get("/api/stream-url", async (req, res) => {
  try {
    const { video_id } = req.query;
    if (!video_id) return res.status(400).json({ error: "video_id requerido" });

    const info = await youtube.getBasicInfo(video_id, { client: "YTMUSIC" });
    const status = info.playability_status?.status;
    if (status !== "OK") {
      return res.status(403).json({ error: info.playability_status?.reason ?? status });
    }

    const format = info.chooseFormat({ type: "audio", quality: "best" });
    if (!format || !format.url) {
      return res.status(404).json({ error: "Sin formato de audio descifrable" });
    }

    res.json({ url: format.url, mime_type: format.mime_type ?? "audio/mp4" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Search ───────────────────────────────────────────────────────────────────
app.get("/api/search", async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: "q es requerido" });
    const results = await youtube.music.search(q);
    const sections = (results.sections ?? []).map(normalizeShelf).filter(Boolean);
    res.json({ sections });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
