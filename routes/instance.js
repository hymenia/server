const express = require('express');
const { pool } = require('../db');
const { instanceName, publicUrl } = require('../config');
const { version } = require('../package.json');

const router = express.Router();

router.get('/.well-known/hymenia', async (req, res) => {
  try {
    const result = await pool.query(
      'select instance_id, created_at from instance_id where singleton = true'
    );
    const identity = result.rows[0];
    if (!identity) {
      return res.status(503).json({ error: 'instance identity is not initialized' });
    }

    res.set('Cache-Control', 'public, max-age=300');
    res.json({
      metadataVersion: 1,
      instance: {
        id: identity.instance_id,
        name: instanceName,
        url: publicUrl
      },
      software: {
        name: 'Hymenia',
        version
      },
      capabilities: ['text-chat', 'voice', 'bots', 'webhooks'],
      createdAt: identity.created_at
    });
  } catch (error) {
    console.error('failed to load instance metadata', error);
    res.status(500).json({ error: 'failed to load instance metadata' });
  }
});

module.exports = router;
