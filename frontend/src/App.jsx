import React, { useState, useEffect } from 'react';

export default function App() {
  const [apiKey, setApiKey] = useState(
    localStorage.getItem('nf_api_key') || 'nf_key_70ac6777c160303a1c3375970e946662b4b07458531eb914'
  );
  const [isConnected, setIsConnected] = useState(!!localStorage.getItem('nf_api_key'));
  const [metrics, setMetrics] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  // Admin Mode States
  const [isAdminMode, setIsAdminMode] = useState(false);
  const [adminPassword, setAdminPassword] = useState('');
  const [isAdminConnected, setIsAdminConnected] = useState(!!localStorage.getItem('nf_admin_token'));
  const [adminToken, setAdminToken] = useState(localStorage.getItem('nf_admin_token') || '');
  const [tenants, setTenants] = useState([]);
  const [adminStats, setAdminStats] = useState(null);
  const [newTenantName, setNewTenantName] = useState('');
  const [newTenantRateLimit, setNewTenantRateLimit] = useState(60);
  const [newTenantKeyToShow, setNewTenantKeyToShow] = useState(null);
  const [showTenantModal, setShowTenantModal] = useState(false);

  // Event Publisher States
  const [publisherEventType, setPublisherEventType] = useState('payment.failed');
  const [publisherUserId, setPublisherUserId] = useState('user-cust-99');
  const [publisherPayloadName, setPublisherPayloadName] = useState('Kavish');
  const [publisherPayloadAmount, setPublisherPayloadAmount] = useState('49.99');
  const [publisherPayloadCustom, setPublisherPayloadCustom] = useState('{"reason": "Insufficient funds"}');
  const [publisherStatus, setPublisherStatus] = useState(null);
  const [publisherError, setPublisherError] = useState(null);

  // Poll metrics on a 5-second interval when connected
  useEffect(() => {
    if (isAdminMode) return;
    if (!isConnected || !apiKey) return;

    fetchMetrics();
    const interval = setInterval(fetchMetrics, 5000);
    return () => clearInterval(interval);
  }, [isConnected, apiKey, isAdminMode]);

  // Poll admin statistics & tenants list
  useEffect(() => {
    if (!isAdminMode || !isAdminConnected || !adminToken) return;

    fetchAdminData(adminToken);
    const interval = setInterval(() => fetchAdminData(adminToken), 10000);
    return () => clearInterval(interval);
  }, [isAdminMode, isAdminConnected, adminToken]);

  const fetchAdminData = async (tokenToUse) => {
    setIsLoading(true);
    try {
      const tenantsRes = await fetch('http://localhost:3000/v1/admin/tenants', {
        headers: { 'Authorization': `Bearer ${tokenToUse}` }
      });
      if (!tenantsRes.ok) throw new Error('Failed to fetch tenants');
      const tenantsData = await tenantsRes.json();
      setTenants(tenantsData.tenants);

      const statsRes = await fetch('http://localhost:3000/v1/admin/stats', {
        headers: { 'Authorization': `Bearer ${tokenToUse}` }
      });
      if (!statsRes.ok) throw new Error('Failed to fetch statistics');
      const statsData = await statsRes.json();
      setAdminStats(statsData);
      setError(null);
    } catch (err) {
      console.error(err);
      setError('Admin connection failed. Check service health or token expiration.');
    } finally {
      setIsLoading(false);
    }
  };

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

  const handleAdminConnect = async (e) => {
    e.preventDefault();
    if (!adminPassword.trim()) return;

    setIsLoading(true);
    try {
      const res = await fetch('http://localhost:3000/v1/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: adminPassword.trim() })
      });

      if (!res.ok) {
        throw new Error('Invalid credentials');
      }

      const data = await res.json();
      localStorage.setItem('nf_admin_token', data.token);
      setAdminToken(data.token);
      setIsAdminConnected(true);
      setError(null);
      setAdminPassword('');
    } catch (err) {
      console.error(err);
      setError('Admin authentication failed. Invalid password.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleAdminDisconnect = () => {
    localStorage.removeItem('nf_admin_token');
    setAdminToken('');
    setIsAdminConnected(false);
    setTenants([]);
    setAdminStats(null);
    setError(null);
  };

  const handleCreateTenant = async (e) => {
    e.preventDefault();
    if (!newTenantName.trim()) return;

    try {
      const res = await fetch('http://localhost:3000/v1/admin/tenants', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${adminToken}`
        },
        body: JSON.stringify({
          name: newTenantName.trim(),
          rateLimit: parseInt(newTenantRateLimit, 10)
        })
      });

      if (!res.ok) {
        throw new Error('Failed to create tenant');
      }

      const data = await res.json();
      setNewTenantKeyToShow(data.apiKey);
      setShowTenantModal(true);
      setNewTenantName('');
      setNewTenantRateLimit(60);
      fetchAdminData(adminToken);
    } catch (err) {
      console.error(err);
      alert(`Tenant creation failed: ${err.message}`);
    }
  };

  const handleFireEvent = async (e) => {
    e.preventDefault();
    setPublisherStatus(null);
    setPublisherError(null);

    let parsedPayload = {};
    try {
      if (publisherPayloadCustom.trim()) {
        parsedPayload = JSON.parse(publisherPayloadCustom.trim());
      }
    } catch (err) {
      setPublisherError('Invalid JSON in payload fields.');
      return;
    }

    const payloadBody = {
      name: publisherPayloadName,
      amount: parseFloat(publisherPayloadAmount) || 0,
      currency: 'USD',
      ...parsedPayload
    };

    const payload = {
      clientEventId: `client-txn-${Date.now()}`,
      tenantId: metrics.tenantId,
      userId: publisherUserId.trim(),
      eventType: publisherEventType,
      payload: payloadBody
    };

    try {
      const res = await fetch('http://localhost:3000/v1/events', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey
        },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || `Ingestion failed: ${res.statusText}`);
      }

      setPublisherStatus(`Successfully fired! Event ID: ${data.eventId}`);
      fetchMetrics();
    } catch (err) {
      console.error(err);
      setPublisherError(`Failed to fire event: ${err.message}`);
    }
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
          <h1>{isAdminMode ? 'NotifyFlow Admin' : 'NotifyFlow'}</h1>
          <p>{isAdminMode ? 'System-Wide Operations & Tenant Management' : 'Real-Time Distributed B2B Notification Dashboard'}</p>
        </div>

        <div className="auth-section">
          {isAdminMode ? (
            isAdminConnected && (
              <div className="admin-header-actions">
                {isLoading && <span className="loading-indicator">Updating...</span>}
                <button
                  onClick={() => setIsAdminMode(false)}
                  className="connect-btn"
                  style={{ backgroundColor: 'var(--accent-primary)' }}
                >
                  Tenant Dashboard
                </button>
                <button
                  onClick={handleAdminDisconnect}
                  className="connect-btn"
                  style={{ backgroundColor: 'var(--text-muted)' }}
                >
                  Disconnect Admin
                </button>
              </div>
            )
          ) : (
            !isConnected ? (
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
            )
          )}
        </div>
      </header>

      {/* Error Notifications Banner */}
      {error && <div className="error-banner">{error}</div>}

      {/* ADMIN MODE MAIN LAYER */}
      {isAdminMode ? (
        !isAdminConnected ? (
          /* Admin Login Screen */
          <div className="card" style={{ textAlign: 'center', padding: '60px 40px', maxWidth: '500px', margin: '40px auto' }}>
            <h2 style={{ borderBottom: 'none', marginBottom: '16px' }}>System Administrator Access</h2>
            <form onSubmit={handleAdminConnect} style={{ display: 'flex', flexDirection: 'column', gap: '16px', alignItems: 'stretch' }}>
              <input
                type="password"
                className="api-key-input"
                style={{ width: '100%', padding: '10px 14px' }}
                placeholder="Enter Administrator Password"
                value={adminPassword}
                onChange={(e) => setAdminPassword(e.target.value)}
              />
              <button type="submit" className="connect-btn" style={{ width: '100%', padding: '10px' }}>
                Verify & Log In
              </button>
            </form>
            <div style={{ marginTop: '24px' }}>
              <button className="admin-login-link" onClick={() => { setIsAdminMode(false); setError(null); }}>
                Back to Tenant Dashboard
              </button>
            </div>
          </div>
        ) : (
          /* Admin Dashboard Console */
          <div>
            {/* System Metrics Overview */}
            {adminStats && (
              <section className="stats-grid">
                <div className="stat-card">
                  <span className="label">Ingested Today</span>
                  <span className="value">{adminStats.summary.today}</span>
                  <span className="desc">Total system events today</span>
                </div>
                <div className="stat-card">
                  <span className="label">Total Delivered</span>
                  <span className="value" style={{ color: 'var(--accent-success)' }}>
                    {adminStats.summary.delivered}
                  </span>
                  <span className="desc">System-wide success logs</span>
                </div>
                <div className="stat-card">
                  <span className="label">Total Hard Fails</span>
                  <span className="value" style={{ color: 'var(--accent-danger)' }}>
                    {adminStats.summary.failed}
                  </span>
                  <span className="desc">Logged failures</span>
                </div>
                <div className="stat-card">
                  <span className="label">DLQ Queue Depth</span>
                  <span className="value" style={{ color: adminStats.summary.dlq > 0 ? 'var(--accent-danger)' : 'var(--text-dark)' }}>
                    {adminStats.summary.dlq}
                  </span>
                  <span className="desc">Dead letter events</span>
                </div>
              </section>
            )}

            {/* Health & Tenant Creation Grid */}
            <div className="charts-grid">
              {/* Service Health Checklist */}
              <div className="card">
                <h2>Infrastructure Services Health</h2>
                <div className="health-grid">
                  {adminStats && Object.entries(adminStats.health).map(([service, status]) => {
                    const isHealthy = status === 'Healthy' || status === 'Active';
                    const badgeClass = status === 'Healthy' ? 'healthy' : (status === 'Active' ? 'active' : 'offline');
                    return (
                      <div className="health-item" key={service}>
                        <span>{service}</span>
                        <span className={`health-status-badge ${badgeClass}`}>
                          {status}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Create Tenant Form */}
              <div className="card">
                <h2>Register New B2B Tenant</h2>
                <form onSubmit={handleCreateTenant} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-muted)' }}>Tenant Organization Name</label>
                    <input
                      type="text"
                      className="api-key-input"
                      style={{ width: '100%' }}
                      placeholder="e.g. Acme Corp"
                      value={newTenantName}
                      onChange={(e) => setNewTenantName(e.target.value)}
                      required
                    />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-muted)' }}>Rate Limit (Requests / Min)</label>
                    <input
                      type="number"
                      className="api-key-input"
                      style={{ width: '100%' }}
                      placeholder="60"
                      value={newTenantRateLimit}
                      onChange={(e) => setNewTenantRateLimit(e.target.value)}
                      required
                    />
                  </div>
                  <button type="submit" className="connect-btn" style={{ marginTop: '8px' }}>
                    Generate Cryptographic Credentials
                  </button>
                </form>
              </div>
            </div>

            {/* Registered Tenants List */}
            <section className="card">
              <h2>Registered Tenants</h2>
              {tenants.length === 0 ? (
                <div className="empty-state">No registered tenants found in the database.</div>
              ) : (
                <div className="logs-table-container">
                  <table className="logs-table">
                    <thead>
                      <tr>
                        <th>Organization Name</th>
                        <th>Tenant ID</th>
                        <th>Rate Limit</th>
                        <th>Registered Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tenants.map((t) => (
                        <tr key={t.id}>
                          <td style={{ fontWeight: 600, color: 'var(--text-dark)' }}>{t.name}</td>
                          <td style={{ fontFamily: 'monospace', fontSize: '13px' }}>{t.id}</td>
                          <td>{t.rate_limit_per_minute} req/min</td>
                          <td style={{ color: 'var(--text-muted)', fontSize: '13px' }}>
                            {new Date(t.created_at).toLocaleDateString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        )
      ) : (
        /* TENANT PORTAL MAIN LAYER */
        <div>
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
              <div style={{ marginTop: '24px' }}>
                <button className="admin-login-link" onClick={() => { setIsAdminMode(true); setError(null); }}>
                  Admin Login
                </button>
              </div>
            </div>
          )}

          {/* Main Dashboard Visualizer Panel */}
          {isConnected && metrics && (
            <div>
              {/* Event Publisher Panel */}
              <section className="card" style={{ marginBottom: '24px' }}>
                <h2>Event Ingestion Publisher (Live Demo)</h2>
                <form onSubmit={handleFireEvent} style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr) auto', gap: '16px', alignItems: 'end' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)' }}>Event Type</label>
                    <select
                      className="api-key-input"
                      style={{ width: '100%', padding: '8px' }}
                      value={publisherEventType}
                      onChange={(e) => setPublisherEventType(e.target.value)}
                    >
                      <option value="payment.failed">payment.failed</option>
                      <option value="payment.success">payment.success</option>
                      <option value="user.registered">user.registered</option>
                      <option value="order.shipped">order.shipped</option>
                      <option value="password.reset">password.reset</option>
                    </select>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)' }}>User ID (internal)</label>
                    <input
                      type="text"
                      className="api-key-input"
                      style={{ width: '100%' }}
                      value={publisherUserId}
                      onChange={(e) => setPublisherUserId(e.target.value)}
                      placeholder="e.g. user-cust-99"
                      required
                    />
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)' }}>Payload Name</label>
                    <input
                      type="text"
                      className="api-key-input"
                      style={{ width: '100%' }}
                      value={publisherPayloadName}
                      onChange={(e) => setPublisherPayloadName(e.target.value)}
                      placeholder="Name"
                    />
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)' }}>Payload Amount</label>
                    <input
                      type="text"
                      className="api-key-input"
                      style={{ width: '100%' }}
                      value={publisherPayloadAmount}
                      onChange={(e) => setPublisherPayloadAmount(e.target.value)}
                      placeholder="49.99"
                    />
                  </div>

                  <button type="submit" className="connect-btn" style={{ height: '38px' }}>
                    Fire Event
                  </button>
                </form>

                {/* Optional Custom JSON Payload Fields */}
                <div style={{ marginTop: '12px' }}>
                  <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
                    Optional Custom Payload (JSON format)
                  </label>
                  <input
                    type="text"
                    className="api-key-input"
                    style={{ width: '100%', fontFamily: 'monospace', fontSize: '13px' }}
                    value={publisherPayloadCustom}
                    onChange={(e) => setPublisherPayloadCustom(e.target.value)}
                    placeholder='{"reason": "Insufficient funds", "invoiceId": "inv-88190"}'
                  />
                </div>

                {publisherStatus && (
                  <div style={{ marginTop: '12px', padding: '10px 14px', backgroundColor: 'var(--status-delivered-bg)', color: 'var(--status-delivered-text)', borderRadius: '6px', fontSize: '13px', fontWeight: 600 }}>
                    {publisherStatus}
                  </div>
                )}
                {publisherError && (
                  <div style={{ marginTop: '12px', padding: '10px 14px', backgroundColor: 'var(--status-failed-bg)', color: 'var(--status-failed-text)', borderRadius: '6px', fontSize: '13px', fontWeight: 600 }}>
                    {publisherError}
                  </div>
                )}
              </section>

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
      )}

      {/* API Key Generated Modal */}
      {showTenantModal && newTenantKeyToShow && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h2 style={{ color: 'var(--accent-success)', borderBottom: 'none', marginBottom: '8px', fontSize: '18px', fontWeight: 700 }}>
              Tenant Registered Successfully!
            </h2>
            <p style={{ color: 'var(--text-main)', fontSize: '14px', marginBottom: '16px' }}>
              Save this key — it will not be shown again:
            </p>
            <div style={{
              background: '#f1f3f5',
              padding: '12px',
              borderRadius: '6px',
              fontFamily: 'monospace',
              wordBreak: 'break-all',
              marginBottom: '16px',
              border: '1px solid #dee2e6',
              fontSize: '13px',
              fontWeight: 600,
              color: '#0b7285',
              textAlign: 'center'
            }}>
              {newTenantKeyToShow}
            </div>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
              <button
                className="connect-btn"
                style={{ backgroundColor: 'var(--accent-success)' }}
                onClick={() => {
                  navigator.clipboard.writeText(newTenantKeyToShow);
                  alert('API key copied to clipboard!');
                }}
              >
                Copy Key
              </button>
              <button
                className="connect-btn"
                style={{ backgroundColor: 'var(--text-muted)' }}
                onClick={() => {
                  setShowTenantModal(false);
                  setNewTenantKeyToShow(null);
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
