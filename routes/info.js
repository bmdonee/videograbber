const express = require('express');
const router = express.Router();
const { getVideoInfo, detectPlatform, formatDuration, buildFormats } = require('../utils/ytdlp');

const SUPPORTED = ['youtube', 'facebook', 'tiktok', 'instagram'];

router.post('/', async (req, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    const platform = detectPlatform(url);
    if (platform === 'unknown') {
      return res.status(400).json({ error: 'Unsupported platform. Use YouTube, Facebook, TikTok, or Instagram.' });
    }

    if (!SUPPORTED.includes(platform)) {
      return res.status(400).json({ error: `${platform} is not supported yet.` });
    }

    const info = await getVideoInfo(url);

    const response = {
      platform,
      title: info.title || 'Untitled',
      thumbnail: info.thumbnail || '',
      duration: formatDuration(info.duration),
      durationSeconds: info.duration || 0,
      author: info.uploader || info.channel || 'Unknown',
      uploaderUrl: info.uploader_url || '',
      webpage_url: info.webpage_url || url,
      formats: buildFormats(info)
    };

    res.json(response);
  } catch (error) {
    console.error('Info error:', error.message);
    res.status(500).json({ error: error.message || 'Failed to fetch video information' });
  }
});

module.exports = router;
