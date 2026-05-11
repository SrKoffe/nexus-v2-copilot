import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface ApiSettingsModalProps {
    onClose: () => void;
}

export function ApiSettingsModal({ onClose }: ApiSettingsModalProps) {
    const [apiKey, setApiKey] = useState('');
    const [apiSecret, setApiSecret] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState(false);

    const handleSave = async () => {
        setLoading(true);
        setError(null);
        setSuccess(false);

        try {
            await invoke('save_config', { key: 'MEXC_API_KEY', value: apiKey });
            await invoke('save_config', { key: 'MEXC_API_SECRET', value: apiSecret });
            setSuccess(true);
            setTimeout(() => {
                onClose();
                window.location.reload(); // Reload to pick up new config
            }, 1500);
        } catch (err: any) {
            setError(err.toString());
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="modal-overlay" style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.8)', zIndex: 9999,
            display: 'flex', alignItems: 'center', justifyContent: 'center'
        }}>
            <div className="modal-content" style={{
                background: '#0a0a0c', border: '1px solid #333',
                padding: '24px', width: '400px', fontFamily: 'monospace'
            }}>
                <h2 style={{ margin: '0 0 16px 0', color: '#fff' }}>MEXC API Configuration</h2>

                <div style={{ marginBottom: '16px' }}>
                    <label style={{ display: 'block', color: '#888', marginBottom: '8px' }}>API Key</label>
                    <input
                        type="text"
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        style={{ width: '100%', background: '#111', border: '1px solid #444', color: '#fff', padding: '8px' }}
                    />
                </div>

                <div style={{ marginBottom: '24px' }}>
                    <label style={{ display: 'block', color: '#888', marginBottom: '8px' }}>API Secret</label>
                    <input
                        type="password"
                        value={apiSecret}
                        onChange={(e) => setApiSecret(e.target.value)}
                        style={{ width: '100%', background: '#111', border: '1px solid #444', color: '#fff', padding: '8px' }}
                    />
                </div>

                {error && <div style={{ color: '#ff3366', marginBottom: '16px' }}>{error}</div>}
                {success && <div style={{ color: '#00ffaa', marginBottom: '16px' }}>Successfully saved! Restarting...</div>}

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
                    <button
                        onClick={onClose}
                        style={{ background: 'transparent', border: '1px solid #444', color: '#ccc', padding: '6px 16px', cursor: 'pointer' }}
                    >
                        CANCEL
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={loading || !apiKey || !apiSecret}
                        style={{ background: '#00e1ff', border: 'none', color: '#000', padding: '6px 16px', fontWeight: 'bold', cursor: loading ? 'not-allowed' : 'pointer' }}
                    >
                        {loading ? 'SAVING...' : 'SAVE & RESTART'}
                    </button>
                </div>
            </div>
        </div>
    );
}
