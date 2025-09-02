// package.json
{
  "name": "poprunning-tracker",
  "version": "1.0.0",
  "description": "Link tracking server for Pop! Running AI agents",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js",
    "init-db": "node server.js --init"
  },
  "dependencies": {
    "express": "^4.18.2",
    "cors": "^2.8.5",
    "sqlite3": "^5.1.6",
    "uuid": "^9.0.0",
    "dotenv": "^16.3.1"
  },
  "devDependencies": {
    "nodemon": "^3.0.1"
  }
}

// .env (create this file - don't commit to git)
PORT=3000
DATABASE_PATH=./tracking.db
DASHBOARD_PASSWORD=popadmin123
GHL_LOCATION_ID=hTePW6K5KGjtcS4ClNxK

// server.js
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize SQLite database
const db = new sqlite3.Database(process.env.DATABASE_PATH || './tracking.db');

// Create tables if they don't exist
db.serialize(() => {
  // Links table
  db.run(`
    CREATE TABLE IF NOT EXISTS links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tracking_id TEXT UNIQUE NOT NULL,
      contact_id TEXT NOT NULL,
      contact_email TEXT,
      agent_type TEXT NOT NULL,
      original_url TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      clicked BOOLEAN DEFAULT 0,
      clicked_at DATETIME,
      converted BOOLEAN DEFAULT 0,
      converted_at DATETIME
    )
  `);

  // Click events table (for multiple click tracking)
  db.run(`
    CREATE TABLE IF NOT EXISTS click_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tracking_id TEXT NOT NULL,
      clicked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      ip_address TEXT,
      user_agent TEXT,
      FOREIGN KEY (tracking_id) REFERENCES links (tracking_id)
    )
  `);

  // Conversions table
  db.run(`
    CREATE TABLE IF NOT EXISTS conversions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id TEXT NOT NULL,
      tracking_id TEXT,
      conversion_type TEXT DEFAULT 'appointment',
      converted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      metadata TEXT
    )
  `);

  console.log('✅ Database initialized');
});

// ============ API ENDPOINTS ============

// 1. Register a new link (called from n8n)
app.post('/api/register-link', (req, res) => {
  const { contactId, contactEmail, agentType, originalUrl } = req.body;
  
  if (!contactId || !agentType || !originalUrl) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const trackingId = uuidv4().substring(0, 8); // Shorter ID for cleaner URLs
  
  db.run(
    `INSERT INTO links (tracking_id, contact_id, contact_email, agent_type, original_url)
     VALUES (?, ?, ?, ?, ?)`,
    [trackingId, contactId, contactEmail, agentType, originalUrl],
    function(err) {
      if (err) {
        console.error('Error registering link:', err);
        return res.status(500).json({ error: 'Failed to register link' });
      }
      
      res.json({
        success: true,
        trackingId,
        trackedUrl: `${req.protocol}://${req.get('host')}/t/${trackingId}`,
        originalUrl
      });
    }
  );
});

// 2. Handle link clicks (redirect)
app.get('/t/:trackingId', (req, res) => {
  const { trackingId } = req.params;
  const ipAddress = req.ip;
  const userAgent = req.get('user-agent');
  
  // First, get the original URL
  db.get(
    'SELECT original_url, clicked FROM links WHERE tracking_id = ?',
    [trackingId],
    (err, row) => {
      if (err || !row) {
        console.error('Invalid tracking ID:', trackingId);
        return res.status(404).send('Link not found');
      }
      
      // Log the click event
      db.run(
        'INSERT INTO click_events (tracking_id, ip_address, user_agent) VALUES (?, ?, ?)',
        [trackingId, ipAddress, userAgent]
      );
      
      // Update link as clicked if first click
      if (!row.clicked) {
        db.run(
          'UPDATE links SET clicked = 1, clicked_at = CURRENT_TIMESTAMP WHERE tracking_id = ?',
          [trackingId]
        );
      }
      
      // Redirect to original URL
      res.redirect(row.original_url);
    }
  );
});

// 3. Webhook for GHL appointment booked
app.post('/webhook/appointment', (req, res) => {
  const { contactId, appointmentId } = req.body;
  
  if (!contactId) {
    return res.status(400).json({ error: 'Missing contactId' });
  }
  
  // Find the most recent clicked link for this contact
  db.get(
    `SELECT tracking_id FROM links 
     WHERE contact_id = ? AND clicked = 1 
     ORDER BY clicked_at DESC LIMIT 1`,
    [contactId],
    (err, row) => {
      if (err) {
        console.error('Error finding link:', err);
        return res.status(500).json({ error: 'Database error' });
      }
      
      const trackingId = row ? row.tracking_id : null;
      
      // Record the conversion
      db.run(
        'INSERT INTO conversions (contact_id, tracking_id, metadata) VALUES (?, ?, ?)',
        [contactId, trackingId, JSON.stringify({ appointmentId })],
        (err) => {
          if (err) {
            console.error('Error recording conversion:', err);
            return res.status(500).json({ error: 'Failed to record conversion' });
          }
          
          // Update link as converted if we found one
          if (trackingId) {
            db.run(
              'UPDATE links SET converted = 1, converted_at = CURRENT_TIMESTAMP WHERE tracking_id = ?',
              [trackingId]
            );
          }
          
          res.json({ success: true, trackingId });
        }
      );
    }
  );
});

// 4. Dashboard API - Get statistics
app.get('/api/stats', (req, res) => {
  const { period = 'today', agentType } = req.query;
  
  let dateFilter = '';
  const now = new Date();
  
  switch(period) {
    case 'today':
      dateFilter = `DATE(created_at) = DATE('now', 'localtime')`;
      break;
    case 'week':
      dateFilter = `DATE(created_at) >= DATE('now', '-7 days', 'localtime')`;
      break;
    case 'month':
      dateFilter = `DATE(created_at) >= DATE('now', '-30 days', 'localtime')`;
      break;
    default:
      dateFilter = '1=1'; // All time
  }
  
  if (agentType && agentType !== 'all') {
    dateFilter += ` AND agent_type = '${agentType}'`;
  }
  
  // Get overview stats
  db.get(
    `SELECT 
      COUNT(*) as total_links,
      SUM(clicked) as total_clicks,
      SUM(converted) as total_conversions,
      ROUND(AVG(clicked) * 100, 1) as click_rate,
      ROUND(AVG(CASE WHEN clicked = 1 THEN converted ELSE NULL END) * 100, 1) as conversion_rate
     FROM links 
     WHERE ${dateFilter}`,
    (err, overview) => {
      if (err) {
        console.error('Error fetching stats:', err);
        return res.status(500).json({ error: 'Failed to fetch stats' });
      }
      
      // Get stats by agent type
      db.all(
        `SELECT 
          agent_type,
          COUNT(*) as links_sent,
          SUM(clicked) as clicks,
          SUM(converted) as conversions,
          ROUND(AVG(clicked) * 100, 1) as click_rate,
          ROUND(AVG(CASE WHEN clicked = 1 THEN converted ELSE NULL END) * 100, 1) as conversion_rate
         FROM links 
         WHERE ${dateFilter.replace(" AND agent_type = '" + agentType + "'", "")}
         GROUP BY agent_type
         ORDER BY 
           CASE 
             WHEN agent_type LIKE 'support_%' THEN 1
             WHEN agent_type = 'post_call' THEN 2
             ELSE 3
           END`,
        (err, byAgent) => {
          if (err) {
            console.error('Error fetching agent stats:', err);
            return res.status(500).json({ error: 'Failed to fetch agent stats' });
          }
          
          // Get recent activity
          db.all(
            `SELECT 
              tracking_id,
              agent_type,
              contact_email,
              created_at,
              clicked,
              clicked_at,
              converted
             FROM links 
             WHERE ${dateFilter}
             ORDER BY created_at DESC 
             LIMIT 50`,
            (err, recentActivity) => {
              if (err) {
                console.error('Error fetching recent activity:', err);
                return res.status(500).json({ error: 'Failed to fetch recent activity' });
              }
              
              res.json({
                overview: overview || {},
                byAgent: byAgent || [],
                recentActivity: recentActivity || [],
                period,
                timestamp: new Date().toISOString()
              });
            }
          );
        }
      );
    }
  );
});

// 5. Get link details
app.get('/api/link/:trackingId', (req, res) => {
  const { trackingId } = req.params;
  
  db.get(
    'SELECT * FROM links WHERE tracking_id = ?',
    [trackingId],
    (err, link) => {
      if (err || !link) {
        return res.status(404).json({ error: 'Link not found' });
      }
      
      db.all(
        'SELECT * FROM click_events WHERE tracking_id = ? ORDER BY clicked_at DESC',
        [trackingId],
        (err, clicks) => {
          res.json({
            link,
            clicks: clicks || []
          });
        }
      );
    }
  );
});

// 6. Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    dbPath: process.env.DATABASE_PATH || './tracking.db'
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`
  🚀 Pop! Running Tracker Server Started
  =======================================
  Local:    http://localhost:${PORT}
  Health:   http://localhost:${PORT}/health
  Stats:    http://localhost:${PORT}/api/stats
  
  Ready to track those links! 💪
  `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  db.close(() => {
    console.log('Database connection closed.');
    process.exit(0);
  });
});
