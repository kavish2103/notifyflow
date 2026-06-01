import React, { useState, useEffect } from 'react';

export default function App() {
  const [apiKey, setApiKey] = useState(
    localStorage.getItem('nf_api_key') || 'nf_key_70ac6777c160303a1c3375970e946662b4b07458531eb914'
  );
  const [isConnected, setIsConnected] = useState(!!localStorage.getItem('nf_api_key'));
  const [metrics, setMetrics] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  // Poll metrics on a 5-second interval when connected
  useEffect(() => {
    if (!isConnected || !apiKey) return;

    fetchMetrics();
    const interval = setInterval(fetchMetrics, 5000);
    return () => clearInterval(interval);
  }, [isConnected, apiKey]);

  const fetchMetrics = async () => {
    setIsLoading(true);
    try {
      const res = await fetch('http://localhost:3000/v1/analytics/metrics', {
        method: 'GET',
        headers: {
          'x-api-key': apiKey
        }
      });

      if (!res.ok) {
        throw new Error(`Analytics fetch failed: Status ${res.status}`);
      }

      const data = await res.json();
      setMetrics(data);
      setError(null);
    } catch (err) {
      console.error(err);
      setError('Connection failed. Please check your B2B API Key or backend services.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleConnect = (e) => {
    e.preventDefault();
    if (!apiKey.trim()) return;

    localStorage.setItem('nf_api_key', apiKey.trim());
    setIsConnected(true);
  };

  const handleDisconnect = () => {
    localStorage.removeItem('nf_api_key');
    setIsConnected(false);
    setMetrics(null);
    setError(null);
  };

  // Helper to convert base64 VAPID public key to standard Uint8Array
  const urlBase64ToUint8Array = (base64String) => {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding)
      .replace(/\-/g, '+')
      .replace(/_/g, '/');

    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);

    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  };

  // Handle requesting permission, service worker registration, and Web Push subscription
  const handlePushSubscribe = async () => {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        alert('Web Push is not supported by your current browser.');
        return;
      }

      // 1. Request notification permission
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        alert('Notification permission was denied.');
        return;
      }

      // 2. Register Service Worker
      await navigator.serviceWorker.register('/sw.js');
      
      // Wait robustly until the registered service worker is active and ready
      const registration = await navigator.serviceWorker.ready;
      console.log('Service Worker is active and ready:', registration);

      // 3. Subscribe with the public VAPID key
      const publicVapidKey = 'BBPV-vkpRNEfuIrlGmxCXXUv86F09uLR4IGjk2wGJYzxQNPhRw0Zp9dMHfqHc5wnpOn03LW_3_SC4HiANX2W0Qg';
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicVapidKey)
      });

      console.log('Web Push subscription compiled:', subscription);

      // 4. Save subscription details in PostgreSQL for user user-cust-99
      const userId = 'user-cust-99';
      const res = await fetch(`http://localhost:3000/v1/preferences/${userId}/push-token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey
        },
        body: JSON.stringify({ pushToken: subscription })
      });

      if (!res.ok) {
        throw new Error(`Failed to register push token: Status ${res.status}`);
      }

      alert('Successfully subscribed to browser push alerts! The token was registered in PostgreSQL for user-cust-99.');
    } catch (err) {
      console.error(err);
      alert(`Subscription failed: ${err.message}`);
    }
  };

  // Helper metrics percentages
  const calculateRate = (part, total) => {
    if (!total || total === 0) return '0%';
    return `${((part / total) * 100).toFixed(1)}%`;
  };

  // Timeline max-height scaling helper
  const getMaxTimelineCount = (timeline = []) => {
    if (timeline.length === 0) return 10;
    const maxVal = Math.max(...timeline.map(t => (t.delivered || 0) + (t.failed || 0)));
    return maxVal > 0 ? maxVal : 10;
  };

  const maxTimelineCount = metrics ? getMaxTimelineCount(metrics.timeline) : 10;

  return (
    <div className="dashboard-container">
      {/* 1. Header and Auth Section */}
      <header className="dashboard-header">
        <div className="brand-section">
          <h1>NotifyFlow</h1>
          <p>Real-Time Distributed B2B Notification Dashboard</p>
        </div>

        <div className="auth-section">
          {!isConnected ? (
            <form onSubmit={handleConnect} className="auth-form">
              <input
                type="password"
                className="api-key-input"
                placeholder="Enter B2B API Key (x-api-key)"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
              <button type="submit" className="connect-btn">Connect</button>
            </form>
          ) : (
            <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
              {isLoading && <span className="loading-indicator">Updating...</span>}
              <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--accent-success)' }}>
                ● Active Ingestion Stream
              </span>
              <button onClick={handlePushSubscribe} className="connect-btn" style={{ backgroundColor: 'var(--accent-success)' }}>
                Subscribe to Push
              </button>
              <button onClick={handleDisconnect} className="connect-btn" style={{ backgroundColor: 'var(--text-muted)' }}>
                Disconnect
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Error Notifications Banner */}
      {error && <div className="error-banner">{error}</div>}

      {/* Landing Placeholder when unconnected */}
      {!isConnected && (
        <div className="card" style={{ textAlign: 'center', padding: '60px 40px' }}>
          <h2 style={{ borderBottom: 'none', marginBottom: '8px' }}>Secure B2B Analytics Gate</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '14px', maxWidth: '480px', margin: '0 auto 24px' }}>
            Please connect using a valid NotifyFlow cryptographic API key to view the multi-tenant metrics feed and real-time delivery outcomes.
          </p>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            Seeded Test Key is entered by default above. Simply click <strong>Connect</strong> to begin.
          </div>
        </div>
      )}

      {/* Main Dashboard Visualizer Panel */}
      {isConnected && metrics && (
        <div>
          {/* 2. Overview Stats Cards Grid */}
          <section className="stats-grid">
            <div className="stat-card">
              <span className="label">Total Ingested</span>
              <span className="value">{metrics.summary.total}</span>
              <span className="desc">Total events processed</span>
            </div>

            <div className="stat-card">
              <span className="label">Delivery Success</span>
              <span className="value" style={{ color: 'var(--accent-success)' }}>
                {calculateRate(metrics.summary.delivered, metrics.summary.total)}
              </span>
              <span className="desc">{metrics.summary.delivered} notifications delivered</span>
            </div>

            <div className="stat-card">
              <span className="label">Skip Rate</span>
              <span className="value">
                {calculateRate(metrics.summary.skipped, metrics.summary.total)}
              </span>
              <span className="desc">{metrics.summary.skipped} notifications opted out</span>
            </div>

            <div className="stat-card">
              <span className="label">DLQ Monitor Depth</span>
              <span className="value" style={{ color: metrics.summary.dlqDepth > 0 ? 'var(--accent-danger)' : 'var(--text-dark)' }}>
                {metrics.summary.dlqDepth}
              </span>
              <span className="desc">Events in dead letter queue</span>
            </div>
          </section>

          {/* 3. Distributions & Timeline Trend Row */}
          <section className="charts-grid">
            {/* 3a. Muted Accent Channel Progress Bars */}
            <div className="card">
              <h2>Channel Delivery Distribution</h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                {Object.keys(metrics.channelStats).map(channel => {
                  const stats = metrics.channelStats[channel];
                  const percent = metrics.summary.total > 0 ? (stats.total / metrics.summary.total) * 100 : 0;
                  return (
                    <div className="channel-row" key={channel}>
                      <div className="channel-info">
                        <span className="channel-name">{channel}</span>
                        <span className="channel-count">
                          {stats.total} events ({percent.toFixed(0)}%)
                        </span>
                      </div>
                      <div className="progress-track">
                        <div
                          className={`progress-fill ${channel}`}
                          style={{ width: `${percent}%` }}
                        />
                      </div>
                      <div style={{ display: 'flex', gap: '12px', fontSize: '11px', marginTop: '6px', color: 'var(--text-muted)', fontWeight: 600 }}>
                        <span>Delivered: {stats.delivered}</span>
                        <span>Failed: {stats.failed}</span>
                        <span>Skipped: {stats.skipped}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 3b. Historical CSS Columns Bar Chart */}
            <div className="card">
              <h2>Historical Delivery Timeline</h2>
              {metrics.timeline.length === 0 ? (
                <div className="empty-state">No historical event logs recorded in the last 7 days.</div>
              ) : (
                <div>
                  <div className="bar-chart-container">
                    {metrics.timeline.map((row, idx) => {
                      const totalBar = (row.delivered || 0) + (row.failed || 0);
                      const totalPercent = maxTimelineCount > 0 ? (totalBar / maxTimelineCount) * 100 : 0;
                      
                      const deliverPercent = totalBar > 0 ? (row.delivered / totalBar) * 100 : 0;
                      const failPercent = totalBar > 0 ? (row.failed / totalBar) * 100 : 0;

                      return (
                        <div className="chart-bar-col" key={idx}>
                          <div className="chart-bar-stack" style={{ height: '120px', display: 'flex', flexDirection: 'column-reverse', justifyContent: 'flex-start' }}>
                            <div style={{ height: `${totalPercent}%`, width: '100%', display: 'flex', flexDirection: 'column-reverse' }}>
                              <div
                                className="bar-fill success"
                                style={{ height: `${deliverPercent}%` }}
                                title={`Delivered: ${row.delivered}`}
                              />
                              <div
                                className="bar-fill fail"
                                style={{ height: `${failPercent}%` }}
                                title={`Failed: ${row.failed}`}
                              />
                            </div>
                          </div>
                          <span className="chart-date-label">
                            {row.date.split('-')[2]}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  <div className="chart-legends">
                    <div className="legend-item">
                      <div className="legend-color delivered" />
                      <span>Delivered Success</span>
                    </div>
                    <div className="legend-item">
                      <div className="legend-color failed" />
                      <span>Hard Delivery Failures</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* 4. Recent Real-Time Activity Log Feed Table */}
          <section className="card">
            <h2>Recent Transaction Delivery Logs</h2>
            {metrics.recentLogs.length === 0 ? (
              <div className="empty-state">No delivery outcomes registered. Dispatched messages will appear here.</div>
            ) : (
              <div className="logs-table-container">
                <table className="logs-table">
                  <thead>
                    <tr>
                      <th>Event ID</th>
                      <th>Channel</th>
                      <th>Event Type</th>
                      <th>Status</th>
                      <th>Error Context</th>
                      <th>Timestamp</th>
                    </tr>
                  </thead>
                  <tbody>
                    {metrics.recentLogs.map((log, idx) => (
                      <tr key={idx}>
                        <td style={{ fontWeight: 600, color: 'var(--text-dark)' }}>
                          {log.eventId.substring(0, 13)}...
                        </td>
                        <td style={{ textTransform: 'capitalize' }}>{log.channel}</td>
                        <td>{log.eventType}</td>
                        <td>
                          <span className={`status-badge ${log.status}`}>
                            {log.status}
                          </span>
                        </td>
                        <td style={{ color: 'var(--text-muted)', fontSize: '13px', maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={log.errorMessage}>
                          {log.errorMessage || '—'}
                        </td>
                        <td style={{ color: 'var(--text-muted)', fontSize: '13px' }}>
                          {new Date(log.createdAt).toLocaleTimeString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
