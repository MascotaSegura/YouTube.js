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

// ─── Health check ────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'YouTube.js API is running' });
});

// ─── Stream endpoint ─────────────────────────────────────────────────────────
// GET /api/stream?video_id=<id>
// Redirects to the best audio-only stream URL.
app.get('/api/stream', async (req, res) => {
    try {
        const videoId = req.query.video_id;
        if (!videoId) {
            return res.status(400).json({ error: 'video_id is required' });
        }
        if (!yt) {
            return res.status(503).json({ error: 'YouTube API not ready yet' });
        }

        const info = await yt.getBasicInfo(videoId, { client: 'ANDROID' });

        // Choose best audio-only format (opus > mp4a, highest bitrate)
        const format = info.chooseFormat({ type: 'audio', quality: 'best' });

        if (!format) {
            return res.status(404).json({ error: 'No audio format found for this video' });
        }

        // decipher() is async since youtubei.js v16+
        let url = format.decipher(yt.session.player);
        if (url instanceof Promise) url = await url;

        if (!url) {
            return res.status(404).json({ error: 'Failed to extract stream URL' });
        }

        // Redirect so ExoPlayer follows directly to the CDN
        res.redirect(url);
    } catch (err) {
        console.error('[/api/stream]', err);
        res.status(500).json({ error: err.message ?? 'Internal Server Error' });
    }
});

// ─── Home feed ───────────────────────────────────────────────────────────────
// GET /api/home
app.get('/api/home', async (req, res) => {
    try {
        if (!yt) return res.status(503).json({ error: 'YouTube API not ready yet' });
        const music = yt.music;
        const home = await music.getHomeFeed();
        res.json(home);
    } catch (err) {
        console.error('[/api/home]', err);
        res.status(500).json({ error: err.message ?? 'Internal Server Error' });
    }
});

// ─── Explore ─────────────────────────────────────────────────────────────────
// GET /api/explore
app.get('/api/explore', async (req, res) => {
    try {
        if (!yt) return res.status(503).json({ error: 'YouTube API not ready yet' });
        const music = yt.music;
        const explore = await music.getExplore();
        res.json(explore);
    } catch (err) {
        console.error('[/api/explore]', err);
        res.status(500).json({ error: err.message ?? 'Internal Server Error' });
    }
});

// ─── Moods & Genres ──────────────────────────────────────────────────────────
// GET /api/moods_and_genres
app.get('/api/moods_and_genres', async (req, res) => {
    try {
        if (!yt) return res.status(503).json({ error: 'YouTube API not ready yet' });
        const music = yt.music;
        const moods = await music.getMoodAndGenres();
        res.json(moods);
    } catch (err) {
        console.error('[/api/moods_and_genres]', err);
        res.status(500).json({ error: err.message ?? 'Internal Server Error' });
    }
});

// ─── Browse ──────────────────────────────────────────────────────────────────
// GET /api/browse?browse_id=<id>&params=<params>
app.get('/api/browse', async (req, res) => {
    try {
        if (!yt) return res.status(503).json({ error: 'YouTube API not ready yet' });
        const { browse_id, params } = req.query;
        if (!browse_id) return res.status(400).json({ error: 'browse_id is required' });
        const music = yt.music;
        const result = await music.browse(browse_id, { params });
        res.json(result);
    } catch (err) {
        console.error('[/api/browse]', err);
        res.status(500).json({ error: err.message ?? 'Internal Server Error' });
    }
});

// ─── Search ──────────────────────────────────────────────────────────────────
// GET /api/search?q=<query>
app.get('/api/search', async (req, res) => {
    try {
        if (!yt) return res.status(503).json({ error: 'YouTube API not ready yet' });
        const { q } = req.query;
        if (!q) return res.status(400).json({ error: 'q is required' });
        const music = yt.music;
        const results = await music.search(q);
        res.json(results);
    } catch (err) {
        console.error('[/api/search]', err);
        res.status(500).json({ error: err.message ?? 'Internal Server Error' });
    }
});

app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
});
