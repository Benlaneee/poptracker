const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize SQLite database
const db = new sqlite3.Database('./tracking.db');

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

  // Click events table
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

// Register a new link (called from n8n)
app.post('/api/register-link', (req, res) => {
  const { contactId, contactEmail, agentType, originalUrl } = req.body;
  
  if (!contactId || !agentType || !originalUrl) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const trackingId = uuidv4().substring(0, 8);
  
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

// Handle link clicks (redirect)
app.get('/t/:trackingId', (req, res) => {
  const { trackingId } = req.params;
  const ipAddress = req.ip;
  const userAgent = req.get('user-agent');
  
  db.get(
    'SELECT original_url, clicked FROM links WHERE tracking_id = ?',
    [trackingId],
    (err, row) => {
      if (err || !row) {
        console.error('Invalid tracking ID:', trackingId);
        return res.status(404).send('Link not found');
      }
      
      db.run(
        'INSERT INTO click_events (tracking_id, ip_address, user_agent) VALUES (?, ?, ?)',
        [trackingId, ipAddress, userAgent]
      );
      
      if (!row.clicked) {
        db.run(
          'UPDATE links SET clicked = 1, clicked_at = CURRENT_TIMESTAMP WHERE tracking_id = ?',
          [trackingId]
        );
      }
      
      res.redirect(row.original_url);
    }
  );
});

// Webhook for GHL appointment booked
app.post('/webhook/appointment', (req, res) => {
  const { contactId, appointmentId } = req.body;
  
  if (!contactId) {
    return res.status(400).json({ error: 'Missing contactId' });
  }
  
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
      
      db.run(
        'INSERT INTO conversions (contact_id, tracking_id, metadata) VALUES (?, ?, ?)',
        [contactId, trackingId, JSON.stringify({ appointmentId })],
        (err) => {
          if (err) {
            console.error('Error recording conversion:', err);
            return res.status(500).json({ error: 'Failed to record conversion' });
          }
          
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

// Dashboard API - Get statistics
app.get('/api/stats', (req, res) => {
  const { period = 'today', agentType } = req.query;
  
  let dateFilter = '';
  
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
      dateFilter = '1=1';
  }
  
  if (agentType && agentType !== 'all') {
    dateFilter += ` AND agent_type = '${agentType}'`;
  }
  
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

// Get link details
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

// Health check
app.get('/', (req, res) => {
  res.send('Pop Tracker is running! 🏃');
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    dbPath: './tracking.db'
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
