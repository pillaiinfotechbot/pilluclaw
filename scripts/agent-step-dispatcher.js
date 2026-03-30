/**
 * Agent Step Dispatcher
 * Runs every 5 minutes to check for pending steps and notify assigned agents
 *
 * Flow:
 * 1. Fetch all pending steps with assigned agents from CMDCenter
 * 2. For each step, notify the assigned agent
 * 3. Log results
 */

const https = require('https');

const API_BASE = 'https://cmdcenterapi.pillaiinfotech.com/api/v1';
const BOT_KEY = process.env.CMDCENTER_BOT_KEY || 'nc_bot_pillai2026';

async function fetchJSON(url, options = {}) {
  return new Promise((resolve, reject) => {
    const defaultOptions = {
      method: 'GET',
      headers: {
        'X-Bot-Key': BOT_KEY,
        'Content-Type': 'application/json',
      },
    };

    const finalOptions = { ...defaultOptions, ...options };

    https.request(url, finalOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve({ error: 'Invalid JSON', raw: data });
        }
      });
    }).on('error', reject).end(options.body ? JSON.stringify(options.body) : '');
  });
}

async function dispatchSteps() {
  console.log(`[${new Date().toISOString()}] Agent Step Dispatcher running...`);

  try {
    // Fetch all pending steps
    const stepsRes = await fetchJSON(`${API_BASE}/steps?status=pending&limit=1000`);

    if (!stepsRes.success || !stepsRes.data) {
      console.error('Failed to fetch pending steps:', stepsRes);
      return;
    }

    const pendingSteps = stepsRes.data;
    console.log(`Found ${pendingSteps.length} pending steps`);

    let notified = 0;
    let errors = 0;

    // For each pending step with an assigned agent
    for (const step of pendingSteps) {
      if (!step.assigned_agent) {
        console.log(`⚠️  Step #${step.id} has no assigned agent, skipping`);
        continue;
      }

      try {
        // Mark step as assigned (move to "awaiting start" state)
        // In our simplified flow, pending → agent gets notified and starts immediately
        console.log(`📢 Notifying agent '${step.assigned_agent}' of Step #${step.id}: ${step.title}`);

        // The agent will poll GET /steps?assigned_agent={name}&status=pending
        // or we send a notification via webhook/message (not implemented yet)
        // For now, just log the assignment
        notified++;
      } catch (error) {
        console.error(`❌ Error notifying agent for step #${step.id}:`, error.message);
        errors++;
      }
    }

    console.log(`✅ Dispatcher complete: ${notified} notified, ${errors} errors`);

  } catch (error) {
    console.error('Fatal error in step dispatcher:', error);
  }
}

// Run immediately and then every 5 minutes
dispatchSteps();
setInterval(dispatchSteps, 5 * 60 * 1000);
