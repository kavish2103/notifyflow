import React, { useState, useEffect } from 'react';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000';
const APP_BASE_URL = window.location.origin;

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
  const [eventTypes, setEventTypes] = useState([]);
  
  // Event Catalog States
  const [showEventCatalogModal, setShowEventCatalogModal] = useState(false);
  const [editingEventType, setEditingEventType] = useState(null);
  const [modalEventTypeName, setModalEventTypeName] = useState('');
  const [modalEventTypeDesc, setModalEventTypeDesc] = useState('');
  const [modalConfigEmail, setModalConfigEmail] = useState(false);
  const [modalConfigSms, setModalConfigSms] = useState(false);
  const [modalConfigPush, setModalConfigPush] = useState(false);
  const [modalEmailSubject, setModalEmailSubject] = useState('');
  const [modalEmailBody, setModalEmailBody] = useState('');
  const [modalSmsBody, setModalSmsBody] = useState('');
  const [modalPushBody, setModalPushBody] = useState('');

  const [publisherUserId, setPublisherUserId] = useState('user-cust-99');
  const [recipientEmailOverride, setRecipientEmailOverride] = useState('');
  const [publisherPayload, setPublisherPayload] = useState({});
  const [publisherPayloadCustom, setPublisherPayloadCustom] = useState('{"reason": "Insufficient funds"}');
  const [publisherStatus, setPublisherStatus] = useState(null);
  const [publisherError, setPublisherError] = useState(null);

  // User Subscription States
  const [userPrefs, setUserPrefs] = useState(null);
  const [emailInput, setEmailInput] = useState('');
  const [phoneInput, setPhoneInput] = useState('');
  const [isPrefsLoading, setIsPrefsLoading] = useState(false);

  const getRequiredVariables = () => {
    const selectedEt = eventTypes.find(et => et.eventType === publisherEventType);
    if (!selectedEt || !selectedEt.templates) {
      return ['name', 'amount']; // default fallback
    }

    const variables = new Set();
    const regex = /\{\{([^}]+)\}\}/g;
    
    const emailTpl = selectedEt.templates.email;
    if (emailTpl) {
      if (emailTpl.subject) {
        let match;
        const subRegex = /\{\{([^}]+)\}\}/g;
        while ((match = subRegex.exec(emailTpl.subject)) !== null) {
          variables.add(match[1].trim());
        }
      }
      if (emailTpl.body) {
        let match;
        const bodyRegex = /\{\{([^}]+)\}\}/g;
        while ((match = bodyRegex.exec(emailTpl.body)) !== null) {
          variables.add(match[1].trim());
        }
      }
    }

    const smsTpl = selectedEt.templates.sms;
    if (smsTpl && smsTpl.body) {
      let match;
      const smsRegex = /\{\{([^}]+)\}\}/g;
      while ((match = smsRegex.exec(smsTpl.body)) !== null) {
        variables.add(match[1].trim());
      }
    }

    const pushTpl = selectedEt.templates.push;
    if (pushTpl && pushTpl.body) {
      let match;
      const pushRegex = /\{\{([^}]+)\}\}/g;
      while ((match = pushRegex.exec(pushTpl.body)) !== null) {
        variables.add(match[1].trim());
      }
    }

    return Array.from(variables);
  };

  // Sync publisher payload template fields dynamically
  useEffect(() => {
    const vars = getRequiredVariables();
    const newPayload = {};
    let customDefault = '';

    vars.forEach(v => {
      if (v === 'name') newPayload.name = 'Kavish';
      else if (v === 'amount') newPayload.amount = '49.99';
      else if (v === 'currency') newPayload.currency = 'USD';
      else if (v === 'reason') newPayload.reason = 'Insufficient funds';
      else if (v === 'billingUrl') newPayload.billingUrl = `${APP_BASE_URL}/billing`;
      else if (v === 'invoiceId') newPayload.invoiceId = 'inv-88190';
      else newPayload[v] = '';
    });

    if (publisherEventType === 'payment.failed') {
      customDefault = '{"reason": "Insufficient funds", "invoiceId": "inv-88190"}';
    } else if (publisherEventType === 'order.prepared') {
      customDefault = '{"description": "Your delicious meal has been prepared and is ready for pickup!"}';
    } else {
      customDefault = '{}';
    }

    setPublisherPayload(newPayload);
    setPublisherPayloadCustom(customDefault);
  }, [publisherEventType, eventTypes]);

  // Poll metrics on a 5-second interval when connected
  useEffect(() => {
    if (isAdminMode) return;
    if (!isConnected || !apiKey) return;

    fetchMetrics();
    const interval = setInterval(fetchMetrics, 5000);
    return () => clearInterval(interval);
  }, [isConnected, apiKey, isAdminMode]);

  // Poll event types on a 10-second interval when connected
  useEffect(() => {
    if (isAdminMode) return;
    if (!isConnected || !apiKey) return;

    fetchEventTypes();
    const interval = setInterval(fetchEventTypes, 10000);
    return () => clearInterval(interval);
  }, [isConnected, apiKey, isAdminMode]);

  // Poll admin statistics & tenants list
  useEffect(() => {
    if (!isAdminMode || !isAdminConnected || !adminToken) return;

    fetchAdminData(adminToken);
    const interval = setInterval(() => fetchAdminData(adminToken), 10000);
    return () => clearInterval(interval);
  }, [isAdminMode, isAdminConnected, adminToken]);

  // Poll user preferences and subscription status
  useEffect(() => {
    if (isAdminMode) return;
    if (!isConnected || !apiKey || !publisherUserId) return;

    fetchUserPrefs(publisherUserId);
    const interval = setInterval(() => fetchUserPrefs(publisherUserId), 10000);
    return () => clearInterval(interval);
  }, [isConnected, apiKey, publisherUserId, isAdminMode]);

  const fetchAdminData = async (tokenToUse) => {
    setIsLoading(true);
    try {
      const tenantsRes = await fetch(`${API_BASE_URL}/v1/admin/tenants`, {
        headers: { 'Authorization': `Bearer ${tokenToUse}` }
      });
      if (!tenantsRes.ok) throw new Error('Failed to fetch tenants');
      const tenantsData = await tenantsRes.json();
      setTenants(tenantsData.tenants);

      const statsRes = await fetch(`${API_BASE_URL}/v1/admin/stats`, {
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
      const res = await fetch(`${API_BASE_URL}/v1/analytics/metrics`, {
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

  const fetchEventTypes = async () => {
    if (!isConnected || !apiKey) return;
    try {
      const res = await fetch(`${API_BASE_URL}/v1/event-types`, {
        headers: {
          'x-api-key': apiKey
        }
      });
      if (!res.ok) {
        throw new Error(`Failed to fetch event types: Status ${res.status}`);
      }
      const data = await res.json();
      if (data.status === 'SUCCESS' && Array.isArray(data.eventTypes)) {
        setEventTypes(data.eventTypes);
        // Default to first registered event type if current selection is not in the list
        if (data.eventTypes.length > 0) {
          const names = data.eventTypes.map(e => e.eventType);
          if (!names.includes(publisherEventType)) {
            setPublisherEventType(names[0]);
          }
        }
      }
    } catch (err) {
      console.error('Error fetching event types:', err);
    }
  };

  const fetchUserPrefs = async (targetUserId) => {
    if (!targetUserId || !apiKey) return;
    setIsPrefsLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/v1/preferences/${targetUserId}`, {
        headers: {
          'x-api-key': apiKey
        }
      });
      if (!res.ok) {
        throw new Error(`Failed to fetch user preferences: Status ${res.status}`);
      }
      const data = await res.json();
      setUserPrefs(data);
    } catch (err) {
      console.error('Error fetching user preferences:', err);
    } finally {
      setIsPrefsLoading(false);
    }
  };

  const handleEmailSubscribe = async (e) => {
    e.preventDefault();
    if (!emailInput.trim()) return;

    try {
      const res = await fetch(`${API_BASE_URL}/v1/preferences/${publisherUserId}/email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey
        },
        body: JSON.stringify({ email: emailInput.trim() })
      });

      if (!res.ok) {
        throw new Error('Failed to register email subscription');
      }

      alert(`Successfully subscribed ${publisherUserId} to Email with address ${emailInput.trim()}!`);
      fetchUserPrefs(publisherUserId);
    } catch (err) {
      console.error(err);
      alert(`Email subscription failed: ${err.message}`);
    }
  };

  const handlePhoneSubscribe = async (e) => {
    e.preventDefault();
    if (!phoneInput.trim()) return;

    try {
      const res = await fetch(`${API_BASE_URL}/v1/preferences/${publisherUserId}/phone`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey
        },
        body: JSON.stringify({ phone: phoneInput.trim() })
      });

      if (!res.ok) {
        throw new Error('Failed to register phone subscription');
      }

      alert(`Successfully subscribed ${publisherUserId} to SMS with phone number ${phoneInput.trim()}!`);
      fetchUserPrefs(publisherUserId);
    } catch (err) {
      console.error(err);
      alert(`Phone subscription failed: ${err.message}`);
    }
  };

  const handleTogglePreference = async (channel, newOptedIn) => {
    if (!userPrefs) return;

    const updatedPreferences = userPrefs.preferences.map(p => {
      if (p.channel === channel) {
        return { channel: p.channel, optedIn: newOptedIn };
      }
      return { channel: p.channel, optedIn: p.optedIn };
    });

    try {
      const res = await fetch(`${API_BASE_URL}/v1/preferences/${publisherUserId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey
        },
        body: JSON.stringify({ preferences: updatedPreferences })
      });

      if (!res.ok) {
        throw new Error('Failed to update preferences');
      }

      fetchUserPrefs(publisherUserId);
    } catch (err) {
      console.error(err);
      alert(`Failed to update preferences: ${err.message}`);
    }
  };

  const handleOpenAddModal = () => {
    setEditingEventType(null);
    setModalEventTypeName('');
    setModalEventTypeDesc('');
    setModalConfigEmail(false);
    setModalConfigSms(false);
    setModalConfigPush(false);
    setModalEmailSubject('');
    setModalEmailBody('');
    setModalSmsBody('');
    setModalPushBody('');
    setShowEventCatalogModal(true);
  };

  const handleOpenEditModal = (et) => {
    setEditingEventType(et);
    setModalEventTypeName(et.eventType);
    setModalEventTypeDesc(et.description || '');
    
    const emailTpl = et.templates?.email;
    const smsTpl = et.templates?.sms;
    const pushTpl = et.templates?.push;

    setModalConfigEmail(!!emailTpl);
    setModalEmailSubject(emailTpl?.subject || '');
    setModalEmailBody(emailTpl?.body || '');

    setModalConfigSms(!!smsTpl);
    setModalSmsBody(smsTpl?.body || '');

    setModalConfigPush(!!pushTpl);
    setModalPushBody(pushTpl?.body || '');

    setShowEventCatalogModal(true);
  };

  const handleSaveEventType = async (e) => {
    e.preventDefault();
    if (!modalEventTypeName.trim()) return;

    const payload = {
      eventType: modalEventTypeName.trim(),
      description: modalEventTypeDesc.trim() || undefined
    };

    const templates = {};
    if (modalConfigEmail) {
      templates.email = {
        subject: modalEmailSubject.trim() || undefined,
        body: modalEmailBody
      };
    }
    if (modalConfigSms) {
      templates.sms = {
        body: modalSmsBody
      };
    }
    if (modalConfigPush) {
      templates.push = {
        body: modalPushBody
      };
    }

    if (Object.keys(templates).length > 0 || editingEventType) {
      payload.templates = templates;
    }

    try {
      const res = await fetch(`${API_BASE_URL}/v1/event-types`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey
        },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.message || 'Failed to save event type');
      }

      alert('Event type and templates saved successfully!');
      setShowEventCatalogModal(false);
      fetchEventTypes();
    } catch (err) {
      console.error(err);
      alert(`Error: ${err.message}`);
    }
  };

  const handleDeleteEventType = async (eventTypeToDelete) => {
    if (!confirm(`Are you sure you want to delete '${eventTypeToDelete}' and all its associated templates?`)) return;

    try {
      const res = await fetch(`${API_BASE_URL}/v1/event-types/${eventTypeToDelete}`, {
        method: 'DELETE',
        headers: {
          'x-api-key': apiKey
        }
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.message || 'Failed to delete event type');
      }

      alert('Event type deleted successfully!');
      fetchEventTypes();
    } catch (err) {
      console.error(err);
      alert(`Error: ${err.message}`);
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
      const res = await fetch(`${API_BASE_URL}/v1/admin/login`, {
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
      const res = await fetch(`${API_BASE_URL}/v1/admin/tenants`, {
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
      ...publisherPayload,
      ...parsedPayload
    };

    if (payloadBody.amount !== undefined && payloadBody.amount !== null) {
      const parsedAmount = parseFloat(payloadBody.amount);
      if (!isNaN(parsedAmount)) {
        payloadBody.amount = parsedAmount;
      }
    }

    // If recruiter typed an email override, inject it so the email-worker
    // delivers directly to that address regardless of DB user records
    if (recipientEmailOverride.trim()) {
      payloadBody.email = recipientEmailOverride.trim();
    }

    const payload = {
      clientEventId: `client-txn-${Date.now()}`,
      tenantId: metrics.tenantId,
      userId: publisherUserId.trim(),
      eventType: publisherEventType,
      payload: payloadBody
    };

    try {
      const res = await fetch(`${API_BASE_URL}/v1/events`, {
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
      const publicVapidKey = 'BFRCg15B3yn8SAm0xlenaGbz7Hxk-FwYDInv5kzzHfnXZa0jIbaIDzv2DfuqgCzV7GteZCBg8XMJhUAgHrk6p8U';
      
      // Unsubscribe existing stale subscriptions to guarantee a fresh token from push servers
      const existingSubscription = await registration.pushManager.getSubscription();
      if (existingSubscription) {
        console.log('Unsubscribing existing stale push subscription...');
        await existingSubscription.unsubscribe();
      }

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicVapidKey)
      });

      console.log('Web Push subscription compiled:', subscription);

      // 4. Save subscription details in PostgreSQL for user publisherUserId
      const res = await fetch(`${API_BASE_URL}/v1/preferences/${publisherUserId}/push-token`, {
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

      alert(`Successfully subscribed to browser push alerts! The token was registered in PostgreSQL for ${publisherUserId}.`);
      fetchUserPrefs(publisherUserId);
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
          <h1>{isAdminMode ? 'NotifyFlow Sandbox Admin' : 'NotifyFlow Sandbox'}</h1>
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
              <div className="auth-status-container">
                {isLoading && <span className="loading-indicator">Updating...</span>}
                <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--accent-success)' }}>
                  ● Active Ingestion Stream
                </span>
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
          <div className="card landing-card">
            <h2 className="no-border-title" style={{ marginBottom: '16px' }}>System Administrator Access</h2>
            <form onSubmit={handleAdminConnect} className="vertical-form" style={{ gap: '16px' }}>
              <input
                type="password"
                className="api-key-input"
                placeholder="Enter Administrator Password"
                value={adminPassword}
                onChange={(e) => setAdminPassword(e.target.value)}
              />
              <button type="submit" className="connect-btn">
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
                <form onSubmit={handleCreateTenant} className="vertical-form" style={{ gap: '12px' }}>
                  <div className="form-group">
                    <label>Tenant Organization Name</label>
                    <input
                      type="text"
                      className="api-key-input"
                      placeholder="e.g. Acme Corp"
                      value={newTenantName}
                      onChange={(e) => setNewTenantName(e.target.value)}
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label>Rate Limit (Requests / Min)</label>
                    <input
                      type="number"
                      className="api-key-input"
                      placeholder="60"
                      value={newTenantRateLimit}
                      onChange={(e) => setNewTenantRateLimit(e.target.value)}
                      required
                    />
                  </div>
                  <button type="submit" className="connect-btn">
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
            <div className="card landing-card">
              <h2 className="no-border-title">Secure B2B Analytics Gate</h2>
              <p className="landing-desc">
                Please connect using a valid NotifyFlow cryptographic API key to view the multi-tenant metrics feed and real-time delivery outcomes.
              </p>
              <div className="landing-note">
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
                {eventTypes.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '30px 20px', color: 'var(--text-muted)', fontSize: '14px', border: '1px dashed var(--border-color)', borderRadius: '8px', backgroundColor: 'var(--bg-page)', margin: '10px 0' }}>
                    Register event types in the Event Catalog before firing test events.
                  </div>
                ) : (
                  <>
                    <form onSubmit={handleFireEvent} className="publisher-form">
                      <div className="form-group">
                        <label>Event Type</label>
                        <select
                          className="api-key-input"
                          value={publisherEventType}
                          onChange={(e) => setPublisherEventType(e.target.value)}
                        >
                          {eventTypes.map((et) => (
                            <option key={et.id} value={et.eventType}>
                              {et.eventType}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="form-group">
                        <label>User ID (internal)</label>
                        <input
                          type="text"
                          className="api-key-input"
                          value={publisherUserId}
                          onChange={(e) => setPublisherUserId(e.target.value)}
                          placeholder="e.g. user-cust-99"
                          required
                        />
                      </div>

                      <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span style={{
                            background: 'linear-gradient(135deg, #667eea, #764ba2)',
                            color: 'white',
                            fontSize: '10px',
                            fontWeight: 700,
                            padding: '2px 7px',
                            borderRadius: '4px',
                            letterSpacing: '0.5px'
                          }}>DEMO</span>
                          Recipient Email Override
                          <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 400 }}>(delivers notification to this address directly)</span>
                        </label>
                        <input
                          id="recipient-email-override"
                          type="email"
                          className="api-key-input"
                          value={recipientEmailOverride}
                          onChange={(e) => setRecipientEmailOverride(e.target.value)}
                          placeholder="Enter your email — receive the notification in your inbox in ~10 seconds"
                          style={{
                            borderColor: recipientEmailOverride ? 'var(--accent-primary)' : undefined,
                            boxShadow: recipientEmailOverride ? '0 0 0 2px rgba(99,102,241,0.15)' : undefined
                          }}
                        />
                        {recipientEmailOverride && (
                          <span style={{ fontSize: '11px', color: 'var(--accent-success)', fontWeight: 600, marginTop: '4px', display: 'block' }}>
                            ✓ Notification will be delivered to {recipientEmailOverride}
                          </span>
                        )}
                      </div>

                      {Object.keys(publisherPayload).map((key) => (
                        <div key={key} className="form-group">
                          <label>
                            {key === 'name' ? 'Payload Name' : (key === 'amount' ? 'Payload Amount' : key.charAt(0).toUpperCase() + key.slice(1))}
                          </label>
                          <input
                            type="text"
                            className="api-key-input"
                            value={publisherPayload[key] || ''}
                            onChange={(e) => setPublisherPayload({
                              ...publisherPayload,
                              [key]: e.target.value
                            })}
                            placeholder={key}
                          />
                        </div>
                      ))}

                      <button type="submit" className="connect-btn" style={{ height: '38px', width: '100%' }}>
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
                  </>
                )}

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

              {/* Event Catalog Table Section */}
              <section className="card" style={{ marginBottom: '24px' }}>
                <div className="card-header no-border">
                  <h2>Event Catalog</h2>
                  <button onClick={handleOpenAddModal} className="connect-btn">
                    + Add Event Type
                  </button>
                </div>
                {eventTypes.length === 0 ? (
                  <div className="empty-state">No registered event types found in catalog. Add event types to get started.</div>
                ) : (
                  <div className="logs-table-container">
                    <table className="logs-table">
                      <thead>
                        <tr>
                          <th>Event Type</th>
                          <th>Description</th>
                          <th style={{ textAlign: 'center' }}>Email Template</th>
                          <th style={{ textAlign: 'center' }}>SMS Template</th>
                          <th style={{ textAlign: 'center' }}>Push Template</th>
                          <th style={{ textAlign: 'center' }}>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {eventTypes.map((et) => {
                          const hasEmail = !!et.templates?.email;
                          const hasSms = !!et.templates?.sms;
                          const hasPush = !!et.templates?.push;
                          return (
                            <tr key={et.id}>
                              <td style={{ fontWeight: 600, color: 'var(--text-dark)' }}>{et.eventType}</td>
                              <td style={{ color: 'var(--text-muted)', fontSize: '13px' }}>{et.description || '—'}</td>
                              <td style={{ textAlign: 'center', fontSize: '16px' }}>
                                {hasEmail ? <span style={{ color: 'var(--accent-success)', fontWeight: 'bold' }}>✓</span> : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                              </td>
                              <td style={{ textAlign: 'center', fontSize: '16px' }}>
                                {hasSms ? <span style={{ color: 'var(--accent-success)', fontWeight: 'bold' }}>✓</span> : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                              </td>
                              <td style={{ textAlign: 'center', fontSize: '16px' }}>
                                {hasPush ? <span style={{ color: 'var(--accent-success)', fontWeight: 'bold' }}>✓</span> : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                              </td>
                              <td style={{ textAlign: 'center' }}>
                                <div style={{ display: 'flex', gap: '8px', justifyContent: 'center' }}>
                                  <button onClick={() => handleOpenEditModal(et)} className="connect-btn" style={{ padding: '4px 8px', fontSize: '12px' }}>
                                    Edit
                                  </button>
                                  <button onClick={() => handleDeleteEventType(et.eventType)} className="connect-btn" style={{ padding: '4px 8px', fontSize: '12px', backgroundColor: 'var(--status-failed-text)' }}>
                                    Delete
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              {/* User Subscription & Preferences Card */}
              <section className="card" style={{ marginBottom: '24px' }}>
                <div className="card-header">
                  <h2>User Preferences & Channel Subscriptions</h2>
                  <div className="card-header-actions">
                    <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-muted)' }}>Target User:</span>
                    <span className="status-badge" style={{ backgroundColor: 'var(--accent-primary)', color: 'white', textTransform: 'none', fontSize: '13px', padding: '4px 10px' }}>
                      {publisherUserId}
                    </span>
                  </div>
                </div>

                {isPrefsLoading && !userPrefs ? (
                  <div className="empty-state">Loading user subscription status...</div>
                ) : (
                  <div className="preferences-grid">
                    {/* EMAIL CHANNEL */}
                    <div className="preference-channel-card">
                      <div>
                        <div className="preference-channel-header">
                          <h3>📧 Email</h3>
                          <span className={`status-badge ${userPrefs?.email ? 'delivered' : 'failed'}`}>
                            {userPrefs?.email ? 'Subscribed' : 'Not Subscribed'}
                          </span>
                        </div>

                        <p className="preference-channel-desc">
                          {userPrefs?.email ? `Registered: ${userPrefs.email}` : 'No email address registered for this user ID.'}
                        </p>

                        <div className="preference-channel-optin">
                          <input
                            type="checkbox"
                            id="pref-toggle-email"
                            checked={userPrefs?.preferences?.find(p => p.channel === 'email')?.optedIn !== false}
                            onChange={(e) => handleTogglePreference('email', e.target.checked)}
                            disabled={!userPrefs?.email}
                            style={{ cursor: userPrefs?.email ? 'pointer' : 'not-allowed' }}
                          />
                          <label htmlFor="pref-toggle-email" style={{ color: userPrefs?.email ? 'var(--text-main)' : 'var(--text-muted)', cursor: userPrefs?.email ? 'pointer' : 'not-allowed' }}>
                            Opt-in to Email Channel
                          </label>
                        </div>
                      </div>

                      <form onSubmit={handleEmailSubscribe} className="vertical-form">
                        <input
                          type="email"
                          className="api-key-input"
                          placeholder="Enter Email Address"
                          value={emailInput}
                          onChange={(e) => setEmailInput(e.target.value)}
                          required
                        />
                        <button type="submit" className="connect-btn">
                          Subscribe Email
                        </button>
                      </form>
                    </div>

                    {/* BROWSER PUSH CHANNEL */}
                    <div className="preference-channel-card">
                      <div>
                        <div className="preference-channel-header">
                          <h3>🔔 Browser Push</h3>
                          <span className={`status-badge ${userPrefs?.hasPushToken ? 'delivered' : 'failed'}`}>
                            {userPrefs?.hasPushToken ? 'Subscribed' : 'Not Subscribed'}
                          </span>
                        </div>

                        <p className="preference-channel-desc">
                          {userPrefs?.hasPushToken ? 'Active Web Push token registered in DB.' : 'No active web push token registered for this user ID.'}
                        </p>

                        <div className="preference-channel-optin">
                          <input
                            type="checkbox"
                            id="pref-toggle-push"
                            checked={userPrefs?.preferences?.find(p => p.channel === 'push')?.optedIn !== false}
                            onChange={(e) => handleTogglePreference('push', e.target.checked)}
                            disabled={!userPrefs?.hasPushToken}
                            style={{ cursor: userPrefs?.hasPushToken ? 'pointer' : 'not-allowed' }}
                          />
                          <label htmlFor="pref-toggle-push" style={{ color: userPrefs?.hasPushToken ? 'var(--text-main)' : 'var(--text-muted)', cursor: userPrefs?.hasPushToken ? 'pointer' : 'not-allowed' }}>
                            Opt-in to Push Channel
                          </label>
                        </div>
                      </div>

                      <button
                        onClick={handlePushSubscribe}
                        className="connect-btn"
                        style={{ backgroundColor: 'var(--accent-success)', marginTop: 'auto' }}
                      >
                        {userPrefs?.hasPushToken ? 'Re-Subscribe Browser' : 'Subscribe to Push'}
                      </button>
                    </div>

                    {/* SMS / PHONE CHANNEL */}
                    <div className="preference-channel-card">
                      <div>
                        <div className="preference-channel-header">
                          <h3>📱 SMS</h3>
                          <span className={`status-badge ${userPrefs?.phone ? 'delivered' : 'failed'}`}>
                            {userPrefs?.phone ? 'Subscribed' : 'Not Subscribed'}
                          </span>
                        </div>

                        <p className="preference-channel-desc">
                          {userPrefs?.phone ? `Registered: ${userPrefs.phone}` : 'No phone number registered for this user ID.'}
                        </p>

                        <div className="preference-channel-optin">
                          <input
                            type="checkbox"
                            id="pref-toggle-sms"
                            checked={userPrefs?.preferences?.find(p => p.channel === 'sms')?.optedIn !== false}
                            onChange={(e) => handleTogglePreference('sms', e.target.checked)}
                            disabled={!userPrefs?.phone}
                            style={{ cursor: userPrefs?.phone ? 'pointer' : 'not-allowed' }}
                          />
                          <label htmlFor="pref-toggle-sms" style={{ color: userPrefs?.phone ? 'var(--text-main)' : 'var(--text-muted)', cursor: userPrefs?.phone ? 'pointer' : 'not-allowed' }}>
                            Opt-in to SMS Channel
                          </label>
                        </div>
                      </div>

                      <form onSubmit={handlePhoneSubscribe} className="vertical-form">
                        <input
                          type="tel"
                          className="api-key-input"
                          placeholder="Enter Phone Number"
                          value={phoneInput}
                          onChange={(e) => setPhoneInput(e.target.value)}
                          required
                        />
                        <button type="submit" className="connect-btn">
                          Subscribe SMS
                        </button>
                      </form>
                    </div>
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
            <h2 className="modal-success-title">
              Tenant Registered Successfully!
            </h2>
            <p className="modal-desc">
              Save this key — it will not be shown again:
            </p>
            <div className="modal-key-display">
              {newTenantKeyToShow}
            </div>
            <div className="modal-actions">
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

      {/* Event Catalog Add/Edit Modal */}
      {showEventCatalogModal && (
        <div className="modal-overlay">
          <div className="modal-content large">
            <h2 className="no-border-title">
              {editingEventType ? `Edit Event Type: ${modalEventTypeName}` : 'Add New Event Type'}
            </h2>
            
            <form onSubmit={handleSaveEventType} className="vertical-form" style={{ marginTop: '16px' }}>
              <div className="form-group">
                <label>Event Type Name</label>
                <input
                  type="text"
                  className="api-key-input"
                  placeholder="e.g. order.prepared"
                  value={modalEventTypeName}
                  onChange={(e) => setModalEventTypeName(e.target.value)}
                  disabled={!!editingEventType}
                  required
                />
              </div>

              <div className="form-group">
                <label>Description (optional)</label>
                <input
                  type="text"
                  className="api-key-input"
                  placeholder="e.g. Triggered when the order has been prepared"
                  value={modalEventTypeDesc}
                  onChange={(e) => setModalEventTypeDesc(e.target.value)}
                />
              </div>

              <div>
                <label style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: '8px' }}>
                  Configure Notification Templates
                </label>

                {/* Email Channel Config */}
                <div className="template-config-box">
                  <div className="checkbox-group">
                    <input
                      type="checkbox"
                      id="modal-config-email"
                      checked={modalConfigEmail}
                      onChange={(e) => setModalConfigEmail(e.target.checked)}
                    />
                    <label htmlFor="modal-config-email">📧 Email Template</label>
                  </div>
                  {modalConfigEmail && (
                    <div className="vertical-form" style={{ marginTop: '8px' }}>
                      <input
                        type="text"
                        className="api-key-input"
                        placeholder="Subject Template (e.g. Order Prepared)"
                        value={modalEmailSubject}
                        onChange={(e) => setModalEmailSubject(e.target.value)}
                      />
                      <textarea
                        className="api-key-input"
                        style={{ minHeight: '80px', fontFamily: 'monospace' }}
                        placeholder="Body Template (Handlebars supported: {{name}}, {{amount}})"
                        value={modalEmailBody}
                        onChange={(e) => setModalEmailBody(e.target.value)}
                        required={modalConfigEmail}
                      />
                    </div>
                  )}
                </div>

                {/* SMS Channel Config */}
                <div className="template-config-box">
                  <div className="checkbox-group">
                    <input
                      type="checkbox"
                      id="modal-config-sms"
                      checked={modalConfigSms}
                      onChange={(e) => setModalConfigSms(e.target.checked)}
                    />
                    <label htmlFor="modal-config-sms">📱 SMS Template</label>
                  </div>
                  {modalConfigSms && (
                    <div style={{ marginTop: '8px' }}>
                      <textarea
                        className="api-key-input"
                        style={{ minHeight: '60px', fontFamily: 'monospace' }}
                        placeholder="Body Template (Handlebars supported: {{name}}, {{amount}})"
                        value={modalSmsBody}
                        onChange={(e) => setModalSmsBody(e.target.value)}
                        required={modalConfigSms}
                      />
                    </div>
                  )}
                </div>

                {/* Push Channel Config */}
                <div className="template-config-box">
                  <div className="checkbox-group">
                    <input
                      type="checkbox"
                      id="modal-config-push"
                      checked={modalConfigPush}
                      onChange={(e) => setModalConfigPush(e.target.checked)}
                    />
                    <label htmlFor="modal-config-push">🔔 Browser Push Template</label>
                  </div>
                  {modalConfigPush && (
                    <div style={{ marginTop: '8px' }}>
                      <textarea
                        className="api-key-input"
                        style={{ minHeight: '60px', fontFamily: 'monospace' }}
                        placeholder="Body Template (Handlebars supported: {{name}}, {{amount}})"
                        value={modalPushBody}
                        onChange={(e) => setModalPushBody(e.target.value)}
                        required={modalConfigPush}
                      />
                    </div>
                  )}
                </div>
              </div>

              <div className="modal-actions" style={{ marginTop: '10px' }}>
                <button type="button" onClick={() => setShowEventCatalogModal(false)} className="connect-btn" style={{ backgroundColor: 'var(--text-muted)' }}>
                  Cancel
                </button>
                <button type="submit" className="connect-btn">
                  Save Changes
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
