import express from 'express';
import cors from 'cors';
import { Innertube, UniversalCache } from 'youtubei.js';

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

let yt;

async function initYoutube() {
    yt = await Innertube.create({
        cache: new UniversalCache(false),
        generate_session_locally: true,
    });
    console.log('YouTubei.js initialized');
}

initYoutube().catch((err) => {
    console.error('Failed to initialize YouTubei.js:', err);
    process.exit(1);
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract a string from a Text object (SDK object, not raw JSON).
 * SDK Text objects have .text property directly.
 */
function getText(obj) {
    if (!obj) return null;
    if (typeof obj === 'string') return obj;
    if (typeof obj.text === 'string') return obj.text;
    if (Array.isArray(obj.runs) && obj.runs[0]?.text) return obj.runs[0].text;
    return String(obj) !== '[object Object]' ? String(obj) : null;
}

/**
 * Extract thumbnail URL from SDK thumbnail array or object.
 */
function getThumbnail(thumbnails) {
    if (!thumbnails) return null;
    const arr = Array.isArray(thumbnails) ? thumbnails : thumbnails?.contents ?? [];
    if (arr.length === 0) return null;
    // Prefer best quality (largest)
    const best = arr.reduce((a, b) =>
        ((b.width ?? 0) > (a.width ?? 0) ? b : a), arr[0]);
    return best?.url ?? null;
}

/**
 * Map SDK endpoint to the flat structure Android expects.
 */
function mapEndpoint(ep) {
    if (!ep) return null;
    // SDK endpoints may have these directly
    return {
        browse_id: ep.payload?.browseId ?? ep.browse_id ?? null,
        playlist_id: ep.payload?.playlistId ?? ep.playlist_id ?? null,
        video_id: ep.payload?.videoId ?? ep.video_id ?? null,
        params: ep.payload?.params ?? ep.params ?? null,
    };
}

/**
 * Map a SDK MusicTwoRowItem / MusicResponsiveListItem to the Item data class.
 */
function mapItem(item) {
    if (!item) return null;
    try {
        const title = getText(item.title);
        const subtitle = getText(item.subtitle);
        const thumbnail = getThumbnail(item.thumbnail);
        const endpoint = mapEndpoint(item.endpoint);
        const kind = item.item_type ?? item.type ?? 'unknown';

        return {
            kind,
            title,
            subtitle,
            thumbnail,
            thumbnail_ratio: 1.0,
            endpoint,
            artists: null,
            album: null,
            duration: null,
        };
    } catch (e) {
        console.error('mapItem error:', e.message, item);
        return null;
    }
}

/**
 * Map a SDK shelf/section to the Section data class.
 */
function mapSection(section) {
    if (!section) return null;
    try {
        // SDK: section.header is a MusicCarouselShelfBasicHeader with .title and .strapline
        const header = section.header;
        const title = getText(header?.title) ?? getText(section.title) ?? null;
        const strapline = getText(header?.strapline) ?? null;

        // section.contents is the SDK array of items
        const contents = section.contents ?? section.items ?? [];
        const items = contents.map(mapItem).filter(Boolean);

        return {
            type: section.type ?? null,
            title,
            strapline,
            items,
            buttons: null,
            description: null,
            footer: null,
        };
    } catch (e) {
        console.error('mapSection error:', e.message);
        return null;
    }
}

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'YouTube.js API is running' });
});

// ─── Stream ───────────────────────────────────────────────────────────────────
app.get('/api/stream', async (req, res) => {
    try {
        const videoId = req.query.video_id;
        if (!videoId) return res.status(400).json({ error: 'video_id is required' });
        if (!yt) return res.status(503).json({ error: 'YouTube API not ready yet' });

        const info = await yt.getBasicInfo(videoId, { client: 'ANDROID' });
        const format = info.chooseFormat({ type: 'audio', quality: 'best' });
        if (!format) return res.status(404).json({ error: 'No audio format found' });

        let url = format.decipher(yt.session.player);
        if (url instanceof Promise) url = await url;
        if (!url) return res.status(404).json({ error: 'Failed to extract stream URL' });

        res.redirect(url);
    } catch (err) {
        console.error('[/api/stream]', err.message);
        res.status(500).json({ error: err.message ?? 'Internal Server Error' });
    }
});

// ─── Home ─────────────────────────────────────────────────────────────────────
app.get('/api/home', async (req, res) => {
    try {
        if (!yt) return res.status(503).json({ error: 'YouTube API not ready yet' });

        const home = await yt.music.getHomeFeed();

        // Use SDK sections directly (NOT toJSON() which gives raw internal data)
        const sections = (home.sections ?? []).map(mapSection).filter(Boolean);

        res.json({ background: null, chips: null, sections });
    } catch (err) {
        console.error('[/api/home]', err.message);
        res.status(500).json({ error: err.message ?? 'Internal Server Error' });
    }
});

// ─── Explore ──────────────────────────────────────────────────────────────────
app.get('/api/explore', async (req, res) => {
    try {
        if (!yt) return res.status(503).json({ error: 'YouTube API not ready yet' });

        const explore = await yt.music.getExplore();
        const sections = (explore.sections ?? []).map(mapSection).filter(Boolean);
        res.json({ top_buttons: null, sections });
    } catch (err) {
        console.error('[/api/explore]', err.message);
        res.status(500).json({ error: err.message ?? 'Internal Server Error' });
    }
});

// ─── Moods & Genres ───────────────────────────────────────────────────────────
app.get('/api/moods_and_genres', async (req, res) => {
    try {
        if (!yt) return res.status(503).json({ error: 'YouTube API not ready yet' });

        const moods = await yt.music.getMoodAndGenres();

        const sections = (moods.sections ?? []).map((s) => ({
            title: getText(s.header?.title) ?? getText(s.title) ?? null,
            buttons: (s.items ?? s.contents ?? []).map((b) => ({
                text: getText(b.title) ?? null,
                color: b.background_color?.toString() ?? null,
                browse_id: b.endpoint?.payload?.browseId ?? null,
                params: b.endpoint?.payload?.params ?? null,
            })),
        }));

        res.json({ sections });
    } catch (err) {
        console.error('[/api/moods_and_genres]', err.message);
        res.status(500).json({ error: err.message ?? 'Internal Server Error' });
    }
});

// ─── Browse ───────────────────────────────────────────────────────────────────
app.get('/api/browse', async (req, res) => {
    try {
        if (!yt) return res.status(503).json({ error: 'YouTube API not ready yet' });
        const { browse_id, params } = req.query;
        if (!browse_id) return res.status(400).json({ error: 'browse_id is required' });

        const result = await yt.music.browse(browse_id, { params });

        const sections = (result.sections ?? []).map(mapSection).filter(Boolean);
        const header = result.header;

        res.json({
            title: getText(header?.title) ?? null,
            subtitle: getText(header?.subtitle) ?? null,
            thumbnail: getThumbnail(header?.thumbnail?.contents ?? header?.thumbnail) ?? null,
            description: getText(header?.description) ?? null,
            monthly_listeners: null,
            sections,
        });
    } catch (err) {
        console.error('[/api/browse]', err.message);
        res.status(500).json({ error: err.message ?? 'Internal Server Error' });
    }
});

// ─── Search ───────────────────────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
    try {
        if (!yt) return res.status(503).json({ error: 'YouTube API not ready yet' });
        const { q } = req.query;
        if (!q) return res.status(400).json({ error: 'q is required' });

        const results = await yt.music.search(q);
        const sections = (results.sections ?? []).map(mapSection).filter(Boolean);
        res.json({ background: null, chips: null, sections });
    } catch (err) {
        console.error('[/api/search]', err.message);
        res.status(500).json({ error: err.message ?? 'Internal Server Error' });
    }
});

app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
});
