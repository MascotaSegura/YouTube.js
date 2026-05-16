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

function getText(obj) {
    if (!obj) return null;
    if (typeof obj === 'string') return obj;
    if (obj.text) return obj.text;
    if (obj.runs?.[0]?.text) return obj.runs[0].text;
    return null;
}

function getThumbnail(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return null;
    return arr[0].url ?? null;
}

function mapEndpoint(ep) {
    if (!ep) return null;
    const payload = ep.payload ?? {};
    return {
        browse_id: payload.browseId ?? null,
        playlist_id: payload.playlistId ?? null,
        video_id: payload.videoId ?? null,
        params: payload.params ?? null,
    };
}

function mapItem(raw) {
    if (!raw) return null;
    // MusicTwoRowItem (playlists, albums, artists)
    const title = getText(raw.title);
    const subtitle = getText(raw.subtitle);
    const thumbnail = getThumbnail(raw.thumbnail);
    const endpoint = mapEndpoint(raw.endpoint);
    const kind = raw.item_type ?? raw.type ?? 'unknown';

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
}

function mapSection(raw) {
    if (!raw) return null;
    const title = getText(raw.header?.title) ?? getText(raw.title);
    const strapline = getText(raw.header?.strapline) ?? null;
    const items = (raw.contents ?? raw.items ?? [])
        .map(mapItem)
        .filter(Boolean);
    return {
        type: raw.type ?? null,
        title,
        strapline,
        items,
        buttons: null,
        description: null,
        footer: null,
    };
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
        const raw = home.toJSON?.() ?? home;

        const sections = (raw.sections ?? []).map(mapSection).filter(Boolean);

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
        const raw = explore.toJSON?.() ?? explore;

        const sections = (raw.sections ?? []).map(mapSection).filter(Boolean);
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
        const raw = moods.toJSON?.() ?? moods;

        const sections = (raw.sections ?? []).map((s) => ({
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
        const raw = result.toJSON?.() ?? result;

        const sections = (raw.sections ?? []).map(mapSection).filter(Boolean);
        res.json({
            title: getText(raw.header?.title) ?? null,
            subtitle: getText(raw.header?.subtitle) ?? null,
            thumbnail: getThumbnail(raw.header?.thumbnail?.contents ?? raw.header?.thumbnail) ?? null,
            description: getText(raw.header?.description) ?? null,
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
        const raw = results.toJSON?.() ?? results;

        const sections = (raw.sections ?? []).map(mapSection).filter(Boolean);
        res.json({ background: null, chips: null, sections });
    } catch (err) {
        console.error('[/api/search]', err.message);
        res.status(500).json({ error: err.message ?? 'Internal Server Error' });
    }
});

app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
});
