/**
 * Jira Client
 * Handles communication with Jira API for story fetching and test generation
 */

const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

class JiraClient {
  constructor(config) {
    this.baseUrl = config.baseUrl;
    this.email = config.email;
    this.apiToken = config.apiToken;
    this.projectKey = config.projectKey;
    this.cacheDir = path.join(process.cwd(), '.testbot-jira-cache');

    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  /**
   * Get authentication header
   */
  getAuthHeader() {
    const auth = Buffer.from(`${this.email}:${this.apiToken}`).toString('base64');
    return `Basic ${auth}`;
  }

  /**
   * Make authenticated request to Jira API
   */
  async makeRequest(endpoint, options = {}) {
    const url = `${this.baseUrl}/rest/api/3/${endpoint}`;
    const headers = {
      Authorization: this.getAuthHeader(),
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...options.headers,
    };

    try {
      const response = await fetch(url, { ...options, headers });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Jira API error (${response.status}): ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      console.error(`[Jira] Failed to make request to ${endpoint}:`, error.message);
      throw error;
    }
  }

  /**
   * Fetch active user stories (not Done)
   */
  async fetchActiveStories() {
    console.error(`[Jira] Fetching active stories from ${this.projectKey}...`);

    let jql = `project = ${this.projectKey} AND status != "Done" ORDER BY created DESC`;

    const response = await this.makeRequest(
      `search/jql?jql=${encodeURIComponent(jql)}&maxResults=100&fields=summary,description,status,priority,labels,updated,created`
    );

    const stories = response.issues || [];
    console.error(`[Jira] Found ${stories.length} active stories`);

    // Parse stories with acceptance criteria
    const parsedStories = [];
    for (const story of stories) {
      const storyDetails = await this.parseStoryDetails(story);
      parsedStories.push(storyDetails);
    }

    return parsedStories;
  }

  /**
   * Parse story details including acceptance criteria
   */
  async parseStoryDetails(story) {
    const acceptanceCriteria = this.extractAcceptanceCriteria(story);

    return {
      key: story.key,
      summary: story.fields.summary,
      description: story.fields.description,
      status: story.fields.status?.name || 'Unknown',
      priority: story.fields.priority?.name || 'Medium',
      labels: story.fields.labels || [],
      acceptanceCriteria,
      updated: story.fields.updated,
      created: story.fields.created,
    };
  }

  /**
   * Extract acceptance criteria from story description
   */
  extractAcceptanceCriteria(story) {
    const criteria = [];
    const description = story.fields.description || '';

    // Handle string description
    if (typeof description === 'string') {
      criteria.push(...this.parseAcceptanceCriteria(description));
    }
    // Handle Atlassian Document Format
    else if (description.content) {
      const text = this.extractTextFromADF(description);
      criteria.push(...this.parseAcceptanceCriteria(text));
    }

    return [...new Set(criteria)]; // Remove duplicates
  }

  /**
   * Parse acceptance criteria from text
   */
  parseAcceptanceCriteria(text) {
    const criteria = [];
    const lines = text.split('\n');
    let inCriteriaSection = false;

    for (let line of lines) {
      line = line.trim();
      if (!line) continue;

      // Detect acceptance criteria section
      if (line.toLowerCase().includes('acceptance criteria') ||
          line.toLowerCase().includes('acceptance test')) {
        inCriteriaSection = true;
        continue;
      }

      // Stop at next section
      if (inCriteriaSection && line.match(/^#{1,3}\s+\w+/)) {
        inCriteriaSection = false;
      }

      // Extract criteria items
      if (inCriteriaSection) {
        const bulletMatch = line.match(/^[-*]\s+(.+)/);
        const numberedMatch = line.match(/^(\d+\.\s+.+)/);
        const givenWhenThenMatch = line.match(/^(Given|When|Then|And)\s+.+/i);

        if (bulletMatch) {
          criteria.push(bulletMatch[1].trim());
        } else if (numberedMatch) {
          criteria.push(numberedMatch[1].trim());
        } else if (givenWhenThenMatch) {
          criteria.push(line);
        }
      } else if (line.match(/^[-*]\s+(Given|When|Then|And)/i)) {
        const match = line.match(/^[-*]\s+(.+)/);
        if (match) {
          criteria.push(match[1].trim());
        }
      }
    }

    return criteria;
  }

  /**
   * Extract text from Atlassian Document Format
   */
  extractTextFromADF(adf) {
    let text = '';
    if (!adf || !adf.content) return text;

    for (const node of adf.content) {
      if (node.type === 'paragraph' && node.content) {
        for (const textNode of node.content) {
          if (textNode.type === 'text') {
            text += textNode.text + '\n';
          }
        }
      } else if (node.type === 'bulletList' || node.type === 'orderedList') {
        text += this.extractListItems(node) + '\n';
      }
    }

    return text;
  }

  /**
   * Extract list items from ADF
   */
  extractListItems(listNode) {
    let text = '';
    if (!listNode.content) return text;

    for (const item of listNode.content) {
      if (item.type === 'listItem' && item.content) {
        for (const para of item.content) {
          if (para.content) {
            for (const textNode of para.content) {
              if (textNode.type === 'text') {
                text += '- ' + textNode.text + '\n';
              }
            }
          }
        }
      }
    }

    return text;
  }

  /**
   * Get specific story details
   */
  async getStoryDetails(issueKey) {
    const issue = await this.makeRequest(
      `issue/${issueKey}?fields=summary,description,status,priority,labels,updated,created`
    );
    return this.parseStoryDetails(issue);
  }

  /**
   * Save to cache
   */
  saveCache(data, filename) {
    const filepath = path.join(this.cacheDir, filename);
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf-8');
  }

  /**
   * Load from cache
   */
  loadCache(filename) {
    const filepath = path.join(this.cacheDir, filename);
    if (fs.existsSync(filepath)) {
      return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
    }
    return null;
  }
}

module.exports = JiraClient;
