"use client";

import React, { useState, useEffect } from "react";
import {
  Database,
  CheckCircle2,
  AlertCircle,
  Clock,
  RefreshCw,
  Copy,
  Check,
  Sparkles,
  ExternalLink,
  ShieldCheck,
  X,
  Server,
  Layers,
  Key,
  Globe
} from "lucide-react";
import {
  getActiveSupabaseConfig,
  saveSupabaseConfig,
  clearSupabaseConfig,
  testSupabaseConnection,
  ConnectionDiagnosticResult,
  DRUM_PALACE_COMPLETE_SCHEMA_SQL,
} from "@/lib/supabase";
import { seedInitialDataToSupabase } from "@/lib/supabaseDb";

interface SupabaseConnectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfigChanged?: () => void;
}

export default function SupabaseConnectionModal({
  isOpen,
  onClose,
  onConfigChanged,
}: SupabaseConnectionModalProps) {
  const [config, setConfig] = useState<{ url: string; anonKey: string; source: 'env' | 'local' | 'none' }>(() => getActiveSupabaseConfig());
  const [inputUrl, setInputUrl] = useState(() => {
    const c = getActiveSupabaseConfig();
    return c.source !== 'none' ? c.url : '';
  });
  const [inputKey, setInputKey] = useState(() => {
    const c = getActiveSupabaseConfig();
    return c.source !== 'none' ? c.anonKey : '';
  });
  const [isTesting, setIsTesting] = useState(false);
  const [isSeeding, setIsSeeding] = useState(false);
  const [copiedSql, setCopiedSql] = useState(false);
  const [diagnosticResult, setDiagnosticResult] = useState<ConnectionDiagnosticResult | null>(null);
  const [feedbackMsg, setFeedbackMsg] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [activeTab, setActiveTab] = useState<'status' | 'setup' | 'sql' | 'seed'>('status');

  const runDiagnostics = React.useCallback(async () => {
    setIsTesting(true);
    try {
      const result = await testSupabaseConnection();
      setDiagnosticResult(result);
    } catch (e: any) {
      console.error("Diagnostic error:", e);
    } finally {
      setIsTesting(false);
    }
  }, []);

  useEffect(() => {
    let isSubscribed = true;
    if (isOpen) {
      testSupabaseConnection().then((result) => {
        if (isSubscribed) {
          setDiagnosticResult(result);
        }
      }).catch((e) => {
        console.error("Diagnostic error:", e);
      });
    }
    return () => {
      isSubscribed = false;
    };
  }, [isOpen]);

  const handleSaveCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputUrl.trim() || !inputKey.trim()) {
      setFeedbackMsg({ type: 'error', text: 'Please enter both Supabase Project URL and Anon Key.' });
      return;
    }

    if (!inputUrl.startsWith('https://')) {
      setFeedbackMsg({ type: 'error', text: 'Project URL must start with https:// (e.g. https://xyz.supabase.co)' });
      return;
    }

    saveSupabaseConfig(inputUrl.trim(), inputKey.trim());
    const updated = getActiveSupabaseConfig();
    setConfig(updated);
    setFeedbackMsg({ type: 'success', text: 'Supabase credentials saved! Running health checks...' });
    
    await runDiagnostics();
    if (onConfigChanged) onConfigChanged();
  };

  const handleResetConfig = async () => {
    clearSupabaseConfig();
    const updated = getActiveSupabaseConfig();
    setConfig(updated);
    setInputUrl('');
    setInputKey('');
    setFeedbackMsg({ type: 'info', text: 'Supabase connection reset to default/environment.' });
    await runDiagnostics();
    if (onConfigChanged) onConfigChanged();
  };

  const handleSeedDatabase = async () => {
    setIsSeeding(true);
    setFeedbackMsg({ type: 'info', text: 'Seeding Drum Palace catalog into Supabase...' });
    try {
      const res = await seedInitialDataToSupabase();
      if (res.success) {
        setFeedbackMsg({ type: 'success', text: res.message });
        await runDiagnostics();
        if (onConfigChanged) onConfigChanged();
      } else {
        setFeedbackMsg({ type: 'error', text: res.message });
      }
    } catch (err: any) {
      setFeedbackMsg({ type: 'error', text: `Seeding error: ${err?.message || err}` });
    } finally {
      setIsSeeding(false);
    }
  };

  const handleCopySql = () => {
    navigator.clipboard.writeText(DRUM_PALACE_COMPLETE_SCHEMA_SQL);
    setCopiedSql(true);
    setTimeout(() => setCopiedSql(false), 2500);
    setFeedbackMsg({ type: 'success', text: 'PostgreSQL schema copied! Paste it into Supabase SQL Editor.' });
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-fadeIn">
      <div className="bg-[var(--surface,#ffffff)] text-[var(--ink,#101a1b)] border border-[var(--line,#e3e8e8)] w-full max-w-3xl max-h-[90vh] rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--line,#e3e8e8)] bg-[var(--surface-2,#f6f8f8)]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 flex items-center justify-center font-bold">
              <Database className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold flex items-center gap-2">
                Supabase Integration Hub
                <span className="text-xs px-2.5 py-0.5 rounded-full font-medium bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                  {diagnosticResult?.overallStatus === 'connected' ? 'Live Connected' : (diagnosticResult?.overallStatus === 'partial' ? 'Partially Connected' : 'Offline / Local')}
                </span>
              </h2>
              <p className="text-xs text-[var(--muted,#687477)]">
                Manage live PostgreSQL database, authentication, schemas & data sync
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-[var(--muted,#687477)] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex border-b border-[var(--line,#e3e8e8)] px-6 bg-[var(--surface,#ffffff)] gap-6">
          <button
            onClick={() => setActiveTab('status')}
            className={`py-3 text-sm font-semibold border-b-2 flex items-center gap-2 transition-all ${
              activeTab === 'status'
                ? 'border-[var(--accent,#049da4)] text-[var(--accent,#049da4)]'
                : 'border-transparent text-[var(--muted,#687477)] hover:text-[var(--ink,#101a1b)]'
            }`}
          >
            <CheckCircle2 className="w-4 h-4" />
            Health & Status
          </button>
          <button
            onClick={() => setActiveTab('setup')}
            className={`py-3 text-sm font-semibold border-b-2 flex items-center gap-2 transition-all ${
              activeTab === 'setup'
                ? 'border-[var(--accent,#049da4)] text-[var(--accent,#049da4)]'
                : 'border-transparent text-[var(--muted,#687477)] hover:text-[var(--ink,#101a1b)]'
            }`}
          >
            <Key className="w-4 h-4" />
            API Keys & Config
          </button>
          <button
            onClick={() => setActiveTab('sql')}
            className={`py-3 text-sm font-semibold border-b-2 flex items-center gap-2 transition-all ${
              activeTab === 'sql'
                ? 'border-[var(--accent,#049da4)] text-[var(--accent,#049da4)]'
                : 'border-transparent text-[var(--muted,#687477)] hover:text-[var(--ink,#101a1b)]'
            }`}
          >
            <Layers className="w-4 h-4" />
            SQL Schema Migration
          </button>
          <button
            onClick={() => setActiveTab('seed')}
            className={`py-3 text-sm font-semibold border-b-2 flex items-center gap-2 transition-all ${
              activeTab === 'seed'
                ? 'border-[var(--accent,#049da4)] text-[var(--accent,#049da4)]'
                : 'border-transparent text-[var(--muted,#687477)] hover:text-[var(--ink,#101a1b)]'
            }`}
          >
            <Sparkles className="w-4 h-4" />
            Seed Catalog
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {feedbackMsg && (
            <div
              className={`p-3.5 rounded-xl text-sm flex items-center justify-between ${
                feedbackMsg.type === 'success'
                  ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20'
                  : feedbackMsg.type === 'error'
                  ? 'bg-rose-500/10 text-rose-700 dark:text-rose-400 border border-rose-500/20'
                  : 'bg-blue-500/10 text-blue-700 dark:text-blue-400 border border-blue-500/20'
              }`}
            >
              <div className="flex items-center gap-2">
                {feedbackMsg.type === 'success' ? (
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                ) : (
                  <AlertCircle className="w-4 h-4 shrink-0" />
                )}
                <span>{feedbackMsg.text}</span>
              </div>
              <button
                onClick={() => setFeedbackMsg(null)}
                className="opacity-70 hover:opacity-100 p-1"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* TAB 1: Status & Diagnostics */}
          {activeTab === 'status' && (
            <div className="space-y-6">
              {/* Summary Card */}
              <div className="p-4 rounded-xl border border-[var(--line,#e3e8e8)] bg-[var(--surface-2,#f6f8f8)] flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div className="space-y-1">
                  <div className="text-xs font-semibold uppercase tracking-wider text-[var(--muted,#687477)]">
                    Active Endpoint
                  </div>
                  <div className="font-mono text-sm font-bold flex items-center gap-2">
                    <Globe className="w-4 h-4 text-[var(--accent,#049da4)]" />
                    {config.source !== 'none' ? config.url : 'No live project connected (Local Storage active)'}
                  </div>
                  <div className="text-xs text-[var(--muted,#687477)]">
                    Source: {config.source === 'env' ? 'Environment Variables (.env)' : (config.source === 'local' ? 'In-App Saved Credentials' : 'Fallback Local Persistence')}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={runDiagnostics}
                    disabled={isTesting}
                    className="px-3.5 py-2 rounded-xl text-xs font-semibold bg-[var(--accent,#049da4)] text-white hover:opacity-90 flex items-center gap-1.5 transition-all disabled:opacity-50 cursor-pointer"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isTesting ? 'animate-spin' : ''}`} />
                    {isTesting ? 'Checking...' : 'Run Diagnostics'}
                  </button>
                </div>
              </div>

              {/* Checks Checklist */}
              <div className="space-y-3">
                <h3 className="text-sm font-bold uppercase tracking-wider text-[var(--muted,#687477)]">
                  Connection Health Diagnostic Checklist
                </h3>

                <div className="space-y-2">
                  {diagnosticResult?.checks?.map((check, idx) => (
                    <div
                      key={idx}
                      className="p-3.5 rounded-xl border border-[var(--line,#e3e8e8)] bg-[var(--surface,#ffffff)] flex items-start justify-between gap-3 text-sm"
                    >
                      <div className="flex items-start gap-3">
                        {check.status === 'pass' ? (
                          <CheckCircle2 className="w-4 h-4 text-emerald-500 mt-0.5 shrink-0" />
                        ) : check.status === 'warning' ? (
                          <AlertCircle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
                        ) : (
                          <AlertCircle className="w-4 h-4 text-rose-500 mt-0.5 shrink-0" />
                        )}
                        <div>
                          <div className="font-semibold text-xs text-[var(--ink,#101a1b)]">
                            {check.name}
                          </div>
                          <div className="text-xs text-[var(--muted,#687477)] mt-0.5">
                            {check.message}
                          </div>
                        </div>
                      </div>
                      <span
                        className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded ${
                          check.status === 'pass'
                            ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                            : check.status === 'warning'
                            ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                            : 'bg-rose-500/10 text-rose-600 dark:text-rose-400'
                        }`}
                      >
                        {check.status}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: Setup API Keys */}
          {activeTab === 'setup' && (
            <form onSubmit={handleSaveCredentials} className="space-y-5">
              <div className="p-4 rounded-xl bg-blue-500/10 border border-blue-500/20 text-xs text-blue-800 dark:text-blue-300 leading-relaxed">
                Enter your Supabase Project details from your Supabase Dashboard (<span className="font-semibold">Project Settings &rarr; API</span>). You can also set <code className="font-mono bg-blue-500/20 px-1 py-0.5 rounded">NEXT_PUBLIC_SUPABASE_URL</code> and <code className="font-mono bg-blue-500/20 px-1 py-0.5 rounded">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> in your environment.
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-[var(--ink,#101a1b)]">
                  Supabase Project URL
                </label>
                <input
                  type="text"
                  placeholder="https://your-project-id.supabase.co"
                  value={inputUrl}
                  onChange={(e) => setInputUrl(e.target.value)}
                  className="w-full px-3.5 py-2.5 text-sm rounded-xl border border-[var(--line,#e3e8e8)] bg-[var(--surface-2,#f6f8f8)] focus:outline-none focus:ring-2 focus:ring-[var(--accent,#049da4)] font-mono"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-[var(--ink,#101a1b)]">
                  Supabase Anon / Public Key (JWT)
                </label>
                <input
                  type="password"
                  placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
                  value={inputKey}
                  onChange={(e) => setInputKey(e.target.value)}
                  className="w-full px-3.5 py-2.5 text-sm rounded-xl border border-[var(--line,#e3e8e8)] bg-[var(--surface-2,#f6f8f8)] focus:outline-none focus:ring-2 focus:ring-[var(--accent,#049da4)] font-mono"
                />
              </div>

              <div className="flex items-center justify-between pt-2">
                <button
                  type="button"
                  onClick={handleResetConfig}
                  className="px-4 py-2.5 rounded-xl text-xs font-semibold border border-[var(--line,#e3e8e8)] hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer"
                >
                  Reset / Clear Credentials
                </button>

                <button
                  type="submit"
                  disabled={isTesting}
                  className="px-5 py-2.5 rounded-xl text-xs font-semibold bg-[var(--accent,#049da4)] text-white hover:opacity-90 transition-all flex items-center gap-1.5 cursor-pointer shadow-md"
                >
                  <Check className="w-4 h-4" />
                  Save & Connect Database
                </button>
              </div>
            </form>
          )}

          {/* TAB 3: SQL Schema */}
          {activeTab === 'sql' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-xs text-[var(--muted,#687477)]">
                  Copy and run this SQL script in your Supabase Project Dashboard &rarr; <strong>SQL Editor</strong> to create all tables with RLS policies and auth hooks.
                </p>
                <button
                  onClick={handleCopySql}
                  className="px-3.5 py-1.5 rounded-xl text-xs font-semibold bg-[var(--accent,#049da4)] text-white flex items-center gap-1.5 hover:opacity-90 transition-all cursor-pointer shrink-0"
                >
                  {copiedSql ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  {copiedSql ? 'Copied!' : 'Copy SQL Schema'}
                </button>
              </div>

              <div className="relative rounded-xl bg-[#0d1823] border border-[#1d3040] p-4 text-xs font-mono text-[#a8b4bc] max-h-80 overflow-y-auto leading-relaxed">
                <pre>{DRUM_PALACE_COMPLETE_SCHEMA_SQL}</pre>
              </div>
            </div>
          )}

          {/* TAB 4: Seed Catalog */}
          {activeTab === 'seed' && (
            <div className="space-y-5">
              <div className="p-4 rounded-xl border border-[var(--line,#e3e8e8)] bg-[var(--surface-2,#f6f8f8)] space-y-2">
                <h3 className="text-sm font-bold text-[var(--ink,#101a1b)] flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-[var(--accent,#049da4)]" />
                  1-Click Drum Palace Catalog Seeder
                </h3>
                <p className="text-xs text-[var(--muted,#687477)] leading-relaxed">
                  Populate your connected Supabase database with all 16 official Drum Palace pro audio items, acoustic drum sets, custom guitars, stage lighting, and accessories.
                </p>
              </div>

              <div className="p-4 rounded-xl border border-[var(--line,#e3e8e8)] space-y-3">
                <div className="text-xs font-semibold text-[var(--ink,#101a1b)]">What will be seeded:</div>
                <ul className="text-xs text-[var(--muted,#687477)] space-y-1.5 list-disc list-inside">
                  <li>6 Pro Audio Categories (Drums, Guitars, Keyboards, Mixers, Speakers, Stage Lighting)</li>
                  <li>16 High-definition Instrument & Gear listings with full specifications</li>
                  <li>Product variants with SKU codes and Uganda Shillings (UGX) pricing</li>
                  <li>Primary product gallery image records</li>
                </ul>

                <button
                  onClick={handleSeedDatabase}
                  disabled={isSeeding}
                  className="w-full mt-3 py-3 rounded-xl text-xs font-bold bg-[var(--accent,#049da4)] text-white hover:opacity-90 transition-all flex items-center justify-center gap-2 cursor-pointer shadow-md disabled:opacity-50"
                >
                  <RefreshCw className={`w-4 h-4 ${isSeeding ? 'animate-spin' : ''}`} />
                  {isSeeding ? 'Seeding Catalog into Supabase...' : 'Seed Catalog into Supabase Now'}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="px-6 py-3.5 border-t border-[var(--line,#e3e8e8)] bg-[var(--surface-2,#f6f8f8)] flex items-center justify-between text-xs text-[var(--muted,#687477)]">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${diagnosticResult?.overallStatus === 'connected' ? 'bg-emerald-500' : 'bg-amber-500'}`} />
            <span>Response latency: {diagnosticResult?.responseTimeMs ?? 0}ms</span>
          </div>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg font-semibold hover:bg-black/5 dark:hover:bg-white/5 text-[var(--ink,#101a1b)] transition-colors cursor-pointer"
          >
            Close Hub
          </button>
        </div>
      </div>
    </div>
  );
}
