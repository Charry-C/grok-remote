// Per-agent conversation pane with live SSE streaming.
//
// Rendering rules (from PROTOCOL.md, frontend section):
//   per turn, in chronological order:
//   1. user bubble
//   2. thinking tray (collapsed; live mark stays visible) from agent_thought_chunk
//   3. tool log (one tray; collapse hides completed, live rows stay)
//      patched by tool_call_update + tool_call_delta_chunk
//   4. assistant message from agent_message_chunk
//   5. token-usage footer from prompt_result / turn_completed
//      (prompt_complete closes the turn; usage often arrives a beat later)
//
// Plus: available_commands_update, session_summary_generated,
//       _x.ai/session_notification (toast), error (red banner).

import { api } from '../lib/api';
import { openStream } from '../lib/sse';
import attachSlashPalette from '../lib/slash-palette';
import { saveLastAgent } from '../lib/last-agent';
import { setupImageAttach } from '../lib/attach-images';
import {
  el,
  renderUserBubble,
  renderAssistantBubble,
  renderThinkingPane,
  renderToolCard,
  renderTodoWriteCard,
  renderToolLog,
  isTodoWriteToolCall,
  isTerminalToolStatus,
  renderTokenFooter,
  renderCompactedPill,
  renderErrorBanner,
  renderToast,
  renderMarkdownLight,
} from '../lib/render';
import { unwrap, extractText, errorBannerText } from '../lib/acp-payload.js';
import { GROK_MARK_SVG } from '../lib/icons';
import {
  extractTokenMeta,
  hasTurnLedger,
  mergeTokenMeta,
  isTurnCompletedPayload,
} from '../lib/token-usage';
import {
  eventTimeMs,
  hasMatchingUserTurn,
  isNonTextUserContent,
  isReplayPayload,
  isStaleLiveEvent,
  shouldRenderUserBubble,
  userTextsMatch,
} from '../lib/chat-turns';
import { copyToClipboard, serializeConversation } from '../lib/copy';
import { iconHtml } from '../lib/icons';
import { fmtTokens } from '../lib/format';
import { connectionActionFor, contextFromAgent } from '../lib/topbar';

import { pickComposerChips, composerCanSend, insertComposerCommand } from '../lib/composer-chips';
import {
  clampReasoningEffort,
  formatModelChip,
  modelSwitchGate,
  prettyModelId,
  resolveAgentEffort,
  resolveAgentModel,
} from '../lib/model-label';

function speechRecognitionCtor(): (new () => any) | null {
  if (typeof window === 'undefined') return null;
  const w = window as any;
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

function buildChatWelcome(extraClass = ''): HTMLElement {
  return el('div', {
    class: ['chat-welcome', extraClass].filter(Boolean).join(' '),
    role: 'status',
    'aria-label': 'Grok-Build and Grok-TUI. phone to vps agent',
  },
    el('div', { class: 'chat-welcome-hero' },
      el('div', { class: 'chat-welcome-mark', html: GROK_MARK_SVG, 'aria-hidden': 'true' }),
      el('div', { class: 'chat-welcome-brand', 'aria-hidden': 'true' },
        el('span', { class: 'chat-welcome-brand__stem' }, 'Grok-'),
        el('span', { class: 'chat-welcome-brand__slot' },
          el('span', { class: 'chat-welcome-brand__reel' },
            el('span', { class: 'chat-welcome-brand__word' }, 'Build'),
            el('span', { class: 'chat-welcome-brand__word' }, 'TUI'),
            el('span', { class: 'chat-welcome-brand__word' }, 'Build'),
          ),
        ),
      ),
    ),
    el('div', { class: 'chat-welcome-foot' },
      el('div', { class: 'chat-welcome-rule', 'aria-hidden': 'true' }),
      el('p', { class: 'chat-welcome-kicker' }, 'phone to vps agent'),
    ),
  );
}

export class ChatView {
  static _toolsToggleWired: any;
  static _topbarWired: any;
  static _active: any;
  _activeTodoCard!: any;
  _autoScroll!: any;
  _autoScrollTools!: any;
  _bgListViewerEl!: any;
  _bgTermsByCard!: any;
  _bgTermsTimer!: any;
  _bgTermViewerEl!: any;
  _bgTermViewerTimer!: any;
  _chatIntroAbort!: any;
  _chatIntroEl!: any;
  _composerEnabled!: any;
  _dictating!: any;
  _recognition!: any;
  _sendIco!: any;
  _sendLabel!: any;
  _suggestPinned!: any;
  _turnInFlight!: any;
  _chatSplit!: any;
  _chatSplitBuild!: any;
  _chatSplitCollapsed!: any;
  _chatSplitLastSizes!: any;
  _convoSkills!: any;
  _composerFocused!: any;
  _connectPromise!: any;
  _detachAutoScroll!: any;
  _detachPalette!: any;
  _easedScrollPending!: any;
  _easedScrollRaf!: any;
  _easedScrollTarget!: any;
  _easedToolsRaf!: any;
  _easedToolsTarget!: any;
  _historyAll!: any;
  _historyWatermark!: any;
  _inFlightMap!: any;
  _inFlightTimer!: any;
  _isReplaying!: any;
  _jumpToLatestBtn!: any;
  _knownSkills!: any;
  _skillsCwd!: any;
  chromeEl!: any;
  _lastEasedToolsWrite!: any;
  _lastEasedWrite!: any;
  _lastEventTs!: any;
  _lastPayload!: any;
  _lastRenderedTokens!: any;
  _lastServerEcho!: any;
  _modelDisplayNames!: Map<string, string>;
  _modelSwitching!: boolean;
  _onAgentsRefresh!: any;
  _onSettingsChange!: any;
  _onVisibility!: any;
  _payloadModal!: any;
  _pendingTodoSeed!: any;
  _promptCapImage!: any;
  _scrollRaf!: any;
  _sdDirty!: any;
  _sdDirtyNotice!: any;
  _sdFields!: any;
  _sdNameInput!: any;
  _sdNotice!: any;
  _skillCommands!: any;
  _skillsPromise!: any;
  _splitFullscreenBtn!: any;
  _splitToggleBtn!: any;
  _toolsColFullscreen!: any;
  _toolsColTab!: any;
  _toolsFilesMounted!: any;
  _toolsTabBtns!: any;
  activeTurn!: any;
  agentId!: any;
  availableCommands!: any;
  bgTermsStripEl!: any;
  chatSplitEl!: any;
  composerAttachBtn!: any;
  composerAttachSlot!: any;
  composerCancel!: any;
  composerCard!: any;
  composerDebugBtn!: any;
  composerEl!: any;
  composerFileInput!: any;
  composerHint!: any;
  composerMicBtn!: any;
  composerSend!: any;
  composerModelBtn!: any;
  composerSuggestEl!: any;
  composerTa!: any;
  connectBtn!: any;
  convoSkillsStripEl!: any;
  copyConvoBtn!: any;
  currentAgent!: any;
  empty!: any;
  filesMounted!: any;
  filesPane!: any;
  flowMounted!: any;
  flowPane!: any;
  imageAttach!: any;
  inflightPill!: any;
  inFlightStripEl!: any;
  infoPane!: any;
  latestTotalTokens!: any;
  palette!: any;
  root!: any;
  settingsBtn!: any;
  settingsDrawer!: any;
  settingsDrawerOpen!: any;
  starBtn!: any;
  statusEl!: any;
  stream!: any;
  _streamWarnTimer!: ReturnType<typeof setTimeout> | null;
  streamEl!: any;
  tabBtns!: any;
  tabsEl!: any;
  tabsState!: any;
  toastHost!: any;
  tokensPill!: any;
  toolsColEl!: any;
  toolsFilesPaneEl!: any;
  toolsStreamEl!: any;
  traceMounted!: any;
  tracePane!: any;
  turns!: any;
  _pendingUsage!: any;

  constructor() {
    this.agentId = null;
    this.stream  = null;
    this._streamWarnTimer = null;
    this.turns   = []; // each: { user, thinking, tools[], assistant, footer, usageMeta, root }
    this.activeTurn = null;
    this._pendingUsage = null;
    this.availableCommands = [];
    this._composerEnabled = false;
    this._suggestPinned = false;
    this._dictating = false;
    this._recognition = null;
    this._historyWatermark = null;
    this._composerFocused = false;
    this._turnInFlight = false;
    this._connectPromise = null;

    this._knownSkills = null;
    this._skillCommands = [];
    this._skillsPromise = null;
    this._skillsCwd = null;

    this.streamEl  = el('div', { class: 'chat-stream' });
    this.composerEl = this.buildComposer();
    this.chromeEl  = this.buildChrome();
    this.statusEl  = el('div', { class: 'chat-status', hidden: true });
    this.toastHost = el('div', { class: 'toast-host' });
    this._modelDisplayNames = new Map();
    this._modelSwitching = false;

    this.empty = buildChatWelcome('chat-empty');

    // Chat-intro animation state. The Grok-Build → TUI slide plays
    // when an agent with zero turns is opened. _chatIntroAbort cancels
    // it when the first user message lands or the user switches away.
    this._chatIntroAbort = null;
    this._chatIntroEl    = null;

    // Strip pinned above the chat stream that lists tool calls currently
    // in flight. Each chip shows kind + label + live duration; clicking
    // scrolls to that tool's pill in the conversation. Hidden when empty.
    this.inFlightStripEl = el('div', { class: 'inflight-strip', hidden: true });
    this._inFlightMap = new Map(); // toolCallId -> { kind, label, startedAt, chip }
    this._inFlightTimer = null;

    this.root = el('section', { class: 'chat' },
      this.chromeEl,
      el('div', { class: 'chat-body' },
        el('div', { class: 'pane pane--conversation' },
          this.statusEl,
          this.inFlightStripEl,
          this.streamEl,
          this.composerEl,
        ),
        this.toastHost,
      ),
    );

    this.streamEl.appendChild(this.empty);
    this._setComposerEnabled(false);
    this._attachComposerExtras();
    this._initAutoScroll();

    // Tab hidden/closed must not cancel the server turn. On return, reattach
    // the live stream. Only replay disk history when nothing is in flight.
    this._onVisibility = () => {
      if (document.visibilityState !== 'visible' || !this.agentId) return;
      const live = !this.stream || this.stream.isClosed() || this.stream.readyState() === 2;
      if (live) this.openStreamForCurrent();
      if (this.currentAgent) this._ensureConnected(this.currentAgent);
      const running = this.currentAgent && this.currentAgent.status === 'running';
      if (!running) this.refreshHistory().catch(() => {});
    };
    document.addEventListener('visibilitychange', this._onVisibility);

    // Sidebar pushes fresh agent records into the chat view on each poll
    // tick. Pick out the one matching our active agent so the chat header,
    // info tab, and connect/disconnect button reflect live state.
    this._onAgentsRefresh = (ev: any) => {
      if (!this.agentId) return;
      const list = (ev && ev.detail) || [];
      const a = list.find((x: any) => x && x.id === this.agentId);
      if (a) this.applyAgentRefresh(a);
    };
    document.addEventListener('grok-remote:agents-refresh', this._onAgentsRefresh);

    if (!ChatView._topbarWired) {
      document.addEventListener('grok-remote:toggle-connection', () => {
        if (ChatView._active) ChatView._active.toggleConnection();
      });
      ChatView._topbarWired = true;
    }
  }

  mount(parent: any) {
    parent.appendChild(this.root);
    ChatView._active = this;
  }

  _publishTopbarContext() {
    document.dispatchEvent(new CustomEvent('grok-remote:topbar-context', {
      detail: contextFromAgent(this.currentAgent),
    }));
  }

  destroy() {
    this.closeStream();
    this._cancelChatIntro();
    if (this._detachPalette) { try { this._detachPalette(); } catch { /* ignore */ } this._detachPalette = null; }
    if (this._detachAutoScroll) { try { this._detachAutoScroll(); } catch { /* ignore */ } this._detachAutoScroll = null; }
    if (this._inFlightTimer) { try { clearInterval(this._inFlightTimer); } catch { /* ignore */ } this._inFlightTimer = null; }
    if (this.imageAttach) { try { this.imageAttach.destroy(); } catch { /* ignore */ } this.imageAttach = null; }
    document.removeEventListener('visibilitychange', this._onVisibility);
    if (this._onAgentsRefresh) {
      document.removeEventListener('grok-remote:agents-refresh', this._onAgentsRefresh);
      this._onAgentsRefresh = null;
    }
  }

  buildChrome() {
    this.copyConvoBtn = el('button', {
      class: 'tab-action tab-action--copy',
      type: 'button',
      title: 'Copy entire conversation as plain text',
      onclick: () => this.copyConversation(),
    }, 'copy');
    this.tokensPill = el('span', { class: 'tab-tokens', hidden: true });
    this.inflightPill = el('span', { class: 'tab-inflight', hidden: true });
    return el('nav', { class: 'chat-chrome' },
      this.inflightPill,
      this.tokensPill,
      el('div', { class: 'tab-actions-group' }, this.copyConvoBtn),
    );
  }

  _renderInflightPill() {
    const n = this.currentAgent && this.currentAgent.inFlight;
    if (typeof n === 'number' && n > 0) {
      this.inflightPill.hidden = false;
      this.inflightPill.replaceChildren(
        el('span', { class: 'tab-inflight-dot' }),
        document.createTextNode(`${n} tool${n === 1 ? '' : 's'}`),
      );
      this.inflightPill.title = `${n} tool call${n === 1 ? '' : 's'} in flight`;
    } else {
      this.inflightPill.hidden = true;
      this.inflightPill.replaceChildren();
    }
  }

  _renderTokensPill() {
    // Prefer the live value from prompt_result / turn_completed / streaming
    // updates over the snapshot we got at setAgent time.
    const live = (typeof this.latestTotalTokens === 'number') ? this.latestTotalTokens : null;
    const snap = this.currentAgent && this.currentAgent.totalTokens;
    const t = (typeof live === 'number' && live > 0) ? live : (typeof snap === 'number' ? snap : 0);
    if (typeof t === 'number' && t > 0) {
      this.tokensPill.hidden = false;
      const prev = (typeof this._lastRenderedTokens === 'number') ? this._lastRenderedTokens : 0;
      const delta = (prev > 0 && t > prev) ? (t - prev) : 0;
      this.tokensPill.replaceChildren(
        document.createTextNode(fmtTokens(t) + ' tok'),
      );
      if (delta > 0) {
        const deltaSpan = el('span', { class: 'tab-tokens-delta' }, ` +${fmtTokens(delta)}`);
        this.tokensPill.appendChild(deltaSpan);
      }
      this.tokensPill.title = `${t.toLocaleString()} tokens in context${delta > 0 ? ` (+${delta.toLocaleString()} this turn)` : ''}`;
      this._lastRenderedTokens = t;
    } else {
      this.tokensPill.hidden = true;
      this.tokensPill.replaceChildren();
      this._lastRenderedTokens = 0;
    }
  }

  async toggleConnection() {
    if (!this.agentId) return;
    const a = this.currentAgent;
    const action = connectionActionFor(a);
    if (action === 'none') {
      if (this._heldByTui(a)) {
        this.showToast('TUI is using this session. Leave the pager first.', 'warn');
      }
      return;
    }
    try {
      if (action === 'connect') {
        await api.connect(this.agentId);
        this.showToast('connecting...', 'info');
      } else {
        await api.disconnect(this.agentId);
        this.showToast('disconnected; sending a message will reconnect.', 'info');
      }
    } catch (e: any) {
      this.showToast(`${action} failed: ${e.message}`, 'warn');
    } finally {
      setTimeout(() => {
        api.getAgent(this.agentId).then((fresh) => this.applyAgentRefresh(fresh)).catch(() => {});
      }, 500);
    }
  }

  applyAgentRefresh(a: any) {
    if (!a || a.id !== this.agentId) return;
    this.currentAgent = a;
    this._publishTopbarContext();
    this._setTurnBusyFromAgent(a);
    this._syncHeldBy(a);
    this._ensureConnected(a);
    this._loadSkills();
    this._renderTokensPill();
    this._renderInflightPill();
    this._syncModelChip();
  }

  _setTurnBusyFromAgent(a: any) {
    if (!a) {
      this._turnInFlight = false;
      this._syncComposerBar();
      return;
    }
    const dead = a.status === 'disconnected' || a.status === 'exited'
      || a.status === 'killed' || a.status === 'errored' || a.status === 'observed';
    if (dead) {
      this._turnInFlight = false;
    } else if (a.status === 'running' || (typeof a.inFlight === 'number' && a.inFlight > 0)) {
      this._turnInFlight = true;
    } else if (!this.activeTurn) {
      this._turnInFlight = false;
    }
    this._syncComposerBar();
  }

  _heldByTui(agent: any): boolean {
    return !!(agent && agent.heldBy === 'tui');
  }

  _syncHeldBy(agent: any) {
    const held = this._heldByTui(agent);
    this._setComposerEnabled(!held && !!this.agentId);
    this._paintAgentStatus(agent);
  }

  _paintAgentStatus(agent: any) {
    if (!agent) {
      this.showStatus('', 'idle');
      return;
    }
    if (this._heldByTui(agent)) {
      this.showStatus('TUI is using this session · read-only', 'warn');
      return;
    }
    if (agent.status === 'errored') {
      this.showStatus('errored', 'fail');
      return;
    }
    if (agent.status === 'killed') {
      this.showStatus('killed', 'fail');
      return;
    }
    if (agent.status === 'starting') {
      this.showStatus('connecting...', 'idle');
      return;
    }
    this.showStatus('', 'idle');
  }

  _ensureConnected(agent: any) {
    if (!agent || !agent.id || agent.id !== this.agentId) return;
    if (agent.connected) return;
    if (agent.archived) return;
    if (this._heldByTui(agent)) {
      this._syncHeldBy(agent);
      return;
    }
    if (agent.wantedConnected === false) {
      this._paintAgentStatus(agent);
      return;
    }
    if (this._connectPromise) return;
    this.showStatus('connecting...', 'idle');
    this._connectPromise = api.connect(agent.id)
      .then((fresh: any) => {
        if (fresh && fresh.id === this.agentId) this.applyAgentRefresh(fresh);
        else if (this.agentId === agent.id) this._paintAgentStatus(this.currentAgent);
      })
      .catch((e: any) => {
        if (e && e.status === 409) {
          if (this.currentAgent) this.currentAgent.heldBy = 'tui';
          this._syncHeldBy(this.currentAgent);
          return;
        }
        if (this.agentId === agent.id) {
          this.showStatus(`connect failed: ${e && e.message ? e.message : e}`, 'fail');
        }
      })
      .finally(() => { this._connectPromise = null; });
  }

  async copyConversation() {
    if (!this.agentId) {
      this.showToast('no agent selected', 'warn');
      return;
    }
    const text = serializeConversation(this.turns, { agent: this.currentAgent || { id: this.agentId } });
    const ok = await copyToClipboard(text);
    if (ok) {
      this.flashBtnLabel(this.copyConvoBtn, 'copied');
      this.showToast('conversation copied to clipboard.', 'info');
    } else {
      this.showToast('copy failed', 'fail');
    }
  }

  flashBtnLabel(btn: any, tempLabel: any) {
    if (!btn) return;
    const orig = btn.textContent;
    btn.textContent = tempLabel;
    btn.disabled = true;
    setTimeout(() => {
      btn.textContent = orig;
      btn.disabled = false;
    }, 1200);
  }

  focusConversation() {
    /* conversation is the only pane */
  }

  // Back-compat alias for older call sites. New code should use
  // focusConversation().
  beginNewConversation() { this.focusConversation(); }

  buildComposer() {
    const ta = el('textarea', {
      class: 'composer-input',
      rows: '1',
      placeholder: 'Ask anything',
      onkeydown: (ev: any) => {
        // Phones + CJK IMEs: Enter should be a newline. Tap Send instead.
        if (this._isChatMobile()) return;
        if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
          ev.preventDefault();
          this.send();
        }
      },
      oninput: () => {
        this._autosizeComposer();
        this._syncComposerBar();
      },
      onfocus: () => {
        this._composerFocused = true;
        this._renderComposerSuggest();
      },
      onblur: () => {
        this._composerFocused = false;
        this._renderComposerSuggest();
      },
    });

    const fileInput = el('input', {
      type: 'file',
      class: 'composer-file-input',
      accept: 'image/*',
      multiple: '',
      style: { display: 'none' },
    });

    const attachBtn = el('button', {
      class: 'composer-icon-btn composer-attach',
      type: 'button',
      title: 'Attach image (saved to agent uploads/ folder)',
      'aria-label': 'Attach image',
      html: iconHtml('plus'),
      onclick: (ev: any) => { ev.preventDefault(); fileInput.click(); },
    });

    const modelBtn = el('button', {
      class: 'composer-mode-btn composer-model-btn',
      type: 'button',
      title: 'Select model and reasoning effort',
      'aria-label': 'Select model and reasoning effort',
      'aria-haspopup': 'dialog',
      onclick: (ev: any) => { ev.preventDefault(); this._openModelSheet(); },
    },
      el('span', { class: 'composer-mode-ico', html: iconHtml('models') }),
      el('span', { class: 'composer-mode-label' }, 'Model'),
      el('span', { class: 'composer-mode-caret', html: iconHtml('chevron-down') }),
    );

    const sendIco = el('span', { class: 'composer-send-ico', html: iconHtml('send') });
    const sendLabel = el('span', { class: 'composer-send-label' }, 'Send');
    const sendBtn = el('button', {
      class: 'composer-send-btn composer-send',
      type: 'button',
      title: 'Send',
      'aria-label': 'Send',
      onclick: () => {
        if (this._turnInFlight) this.cancel();
        else this.send();
      },
    }, sendIco, sendLabel);

    const hintCaption = el('div', { class: 'composer-hint hidden' });
    const suggestRow = el('div', { class: 'composer-suggest' });
    suggestRow.hidden = true;
    const attachSlot = el('div', { class: 'composer-attach-slot' });

    this.composerTa         = ta;
    this.composerSend       = sendBtn;
    this._sendIco           = sendIco;
    this._sendLabel         = sendLabel;
    const chat = this;
    this.composerCancel     = {
      get disabled() { return !chat._turnInFlight; },
      set disabled(v: boolean) {
        chat._turnInFlight = !v;
        chat._syncComposerBar();
      },
    };
    this.composerFileInput  = fileInput;
    this.composerAttachBtn  = attachBtn;
    this.composerHint       = hintCaption;
    this.composerModelBtn   = modelBtn;
    this.composerMicBtn     = null;
    this.composerSuggestEl  = suggestRow;
    this.composerAttachSlot = attachSlot;
    this.palette = el('div', { class: 'command-palette hidden' });

    this.composerCard = el('div', { class: 'composer-card' },
      attachSlot,
      hintCaption,
      ta,
      el('div', { class: 'composer-bar' },
        el('div', { class: 'composer-bar-left' },
          attachBtn,
          modelBtn,
        ),
        el('div', { class: 'composer-bar-right' },
          sendBtn,
        ),
      ),
      fileInput,
    );

    return el('div', { class: 'composer' },
      this.palette,
      suggestRow,
      this.composerCard,
    );
  }

  _attachComposerExtras() {
    if (this._detachPalette) {
      try { this._detachPalette(); } catch { /* ignore */ }
      this._detachPalette = null;
    }
    if (this.imageAttach) {
      try { this.imageAttach.destroy(); } catch { /* ignore */ }
      this.imageAttach = null;
    }
    if (!this.composerTa) return;

    this._detachPalette = attachSlashPalette({
      textarea: this.composerTa,
      getCommands: () => this._mergedCommands(),
      onCommit: ({ command, hint }) => {
        if (hint && this.composerHint) {
          this.composerHint.textContent = `usage: /${command.name} ${hint}`;
          this.composerHint.classList.remove('hidden');
        } else if (this.composerHint) {
          this.composerHint.classList.add('hidden');
          this.composerHint.textContent = '';
        }
      },
    });

    this.imageAttach = setupImageAttach({
      container: this.composerEl,
      pillsHost: this.composerAttachSlot || this.composerEl,
      textarea: this.composerTa,
      fileInput: this.composerFileInput,
      canAttachImages: () => this._canAttachImages(),
      onChange: ({ error }) => {
        if (error) this.showToast(error, 'warn');
        this._syncAttachBtn();
        this._syncComposerBar();
      },
    });
    this._syncAttachBtn();
    this._syncComposerBar();
    this._renderComposerSuggest();
  }

  _canAttachImages() {
    return !!this._promptCapImage;
  }

  async _loadSkills() {
    const cwd = (this.currentAgent && typeof this.currentAgent.cwd === 'string')
      ? this.currentAgent.cwd.trim()
      : '';
    if (this._skillsPromise && this._skillsCwd === cwd) return this._skillsPromise;
    this._skillsCwd = cwd;
    this._skillsPromise = (async () => {
      try {
        const data: any = await api.skills.list({ cwd: cwd || undefined });
        const set = new Set();
        const palette = [];
        const seenNames = new Set();
        for (const s of ((data && data.skills) || [])) {
          if (!s || typeof s.name !== 'string' || !s.name) continue;
          set.add(s.name);
          if (seenNames.has(s.name)) continue;
          seenNames.add(s.name);
          palette.push({
            name: s.name,
            description: s.description || s.title || '',
            kind: 'skill',
            scope: s.scope || '',
          });
        }
        this._knownSkills = set;
        this._skillCommands = palette;
        this._renderComposerSuggest();
        return set;
      } catch {
        this._knownSkills = new Set();
        this._skillCommands = [];
        this._renderComposerSuggest();
        return this._knownSkills;
      }
    })();
    return this._skillsPromise;
  }

  _decorateSkill(_turn: any) {
    /* skill names stay in the / palette; no settings-page banner */
  }

  _captureAgentCaps(agent: any) {
    // Images are now always allowed: the backend saves attachments to the
    // agent's uploads/ folder, so any model can use them via its own tools.
    // We still track the model's native image capability for informational
    // purposes (Info tab), but it no longer gates the attach button.
    this._promptCapImage = true;
    void agent;
    this._syncAttachBtn();
    if (this.imageAttach) this.imageAttach.refreshSupport();
  }

  _syncAttachBtn() {
    if (!this.composerAttachBtn) return;
    this.composerAttachBtn.disabled = !this._composerEnabled;
    this.composerAttachBtn.classList.toggle('is-disabled', !this._composerEnabled);
  }

  setAvailableCommands(list: any) {
    if (!Array.isArray(list)) return;
    this.availableCommands = list;
    this._renderComposerSuggest();
  }

  _mergedCommands() {
    // Merge agent-advertised commands with the filesystem-discovered skills.
    // Skills are deduplicated by name across scopes so the user sees each
    // once. Agent commands win on name conflict (they're the live API).
    const agentNames = new Set();
    const out = [];
    for (const c of (this.availableCommands || [])) {
      if (!c || typeof c.name !== 'string') continue;
      agentNames.add(c.name);
      out.push(c);
    }
    for (const s of (this._skillCommands || [])) {
      if (!s || agentNames.has(s.name)) continue;
      out.push(s);
    }
    return out;
  }

  _setComposerEnabled(enabled: any) {
    this._composerEnabled = !!enabled;
    if (!this.composerTa) return;
    this.composerTa.disabled = !enabled;
    if (this.composerMicBtn) this.composerMicBtn.disabled = !enabled;
    if (this.composerAttachBtn) this.composerAttachBtn.disabled = !enabled;
    if (!enabled) {
      this.composerCancel.disabled = true;
      this._stopDictation();
    }
    this._syncModelChip();
    this._syncComposerBar();
  }

  _syncComposerBar() {
    if (!this.composerSend) return;
    const busy = !!this._turnInFlight;
    this.composerSend.classList.toggle('composer-send--busy', busy);
    this.composerSend.title = busy ? 'Stop the current turn' : 'Send';
    this.composerSend.setAttribute('aria-label', busy ? 'Stop' : 'Send');
    if (this._sendIco) this._sendIco.innerHTML = iconHtml(busy ? 'stop' : 'send');
    if (this._sendLabel) this._sendLabel.textContent = busy ? 'Stop' : 'Send';
    this._syncModelChip();
    if (busy) {
      this.composerSend.disabled = !this._composerEnabled;
      return;
    }
    const text = this.composerTa ? this.composerTa.value : '';
    const n = this.imageAttach ? this.imageAttach.getAttachments().length : 0;
    this.composerSend.disabled = !this._composerEnabled || !composerCanSend(text, n);
  }

  _renderComposerSuggest() {
    const row = this.composerSuggestEl as HTMLElement | null;
    if (!row) return;
    const hasTurns = Array.isArray(this.turns) && this.turns.length > 0;
    const chips = pickComposerChips(this._mergedCommands(), 6);
    if (!this._composerEnabled || !chips.length || (hasTurns && !this._suggestPinned)) {
      row.replaceChildren();
      row.hidden = true;
      return;
    }
    if (this._isChatMobile() && !this._composerFocused) {
      row.replaceChildren();
      row.hidden = true;
      return;
    }
    row.hidden = false;
    row.replaceChildren();
    for (const chip of chips) {
      row.appendChild(el('button', {
        class: 'composer-chip',
        type: 'button',
        title: chip.description || `/${chip.name}`,
        onclick: () => this._insertComposerCommand(chip.name),
      },
        chip.kind === 'skill'
          ? el('span', { class: 'composer-chip-ico', html: iconHtml('skills') })
          : null,
        el('span', null, `/${chip.name}`),
      ));
    }
  }

  _insertComposerCommand(name: string) {
    if (!this.composerTa || this.composerTa.disabled) return;
    const ta = this.composerTa as HTMLTextAreaElement;
    ta.value = insertComposerCommand(ta.value, name);
    try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch { /* ignore */ }
    ta.focus();
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    this._autosizeComposer();
    this._syncComposerBar();
  }

  _modelSwitchGate() {
    return modelSwitchGate({
      hasAgent: !!this.agentId,
      composerEnabled: this._composerEnabled,
      switching: this._modelSwitching,
      inFlight: this._turnInFlight,
      agent: this.currentAgent,
    });
  }

  _syncModelChip() {
    const btn = this.composerModelBtn as HTMLButtonElement | null;
    if (!btn) return;
    const modelId = resolveAgentModel(this.currentAgent);
    const rawEffort = resolveAgentEffort(this.currentAgent);
    const effort = rawEffort ? clampReasoningEffort(modelId, rawEffort) : '';
    const displayName = (modelId && this._modelDisplayNames.get(modelId)) || '';
    const label = formatModelChip({ modelId, effort, displayName });
    const labelEl = btn.querySelector('.composer-mode-label');
    if (labelEl) labelEl.textContent = label;
    const gate = this._modelSwitchGate();
    btn.disabled = gate.disabled;
    const title = gate.reason
      || (modelId
        ? (prettyModelId(modelId) !== modelId ? `${label} (${modelId})` : label)
        : 'Select model and reasoning effort');
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.setAttribute('aria-disabled', gate.disabled ? 'true' : 'false');
  }

  _openModelSheet() {
    const gate = this._modelSwitchGate();
    if (gate.disabled) {
      if (gate.reason) this.showToast(gate.reason, 'info');
      return;
    }
    void import('./model-sheet.js').then((m) => m.openModelSheet({
      currentModel: resolveAgentModel(this.currentAgent),
      currentEffort: resolveAgentEffort(this.currentAgent),
      onApply: (choice) => this._applyModelChoice(choice),
    }));
  }

  async _applyModelChoice(choice: { model?: string; reasoningEffort?: string; displayName?: string }) {
    if (!this.agentId) return;
    const model = typeof choice.model === 'string' ? choice.model.trim() : '';
    const targetModel = model || resolveAgentModel(this.currentAgent);
    const requestedEffort = typeof choice.reasoningEffort === 'string'
      ? choice.reasoningEffort.trim()
      : '';
    const reasoningEffort = requestedEffort
      ? clampReasoningEffort(targetModel, requestedEffort)
      : '';
    if (choice.displayName && model) {
      this._modelDisplayNames.set(model, choice.displayName);
    }
    if (!model && !reasoningEffort) return;

    const gate = this._modelSwitchGate();
    if (gate.disabled) {
      this.showToast(gate.reason || 'Cannot switch models right now.', 'info');
      return;
    }

    this._modelSwitching = true;
    this._syncModelChip();
    try {
      const updated = await api.switchModel(this.agentId, {
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
      });
      this.applyAgentRefresh(updated);
      if (model) {
        api.patchSettings({ defaultModel: model }).catch(() => {});
      }
      this.showToast('switched model.', 'info');
    } catch (e: any) {
      this.showToast(`model switch failed: ${e && e.message ? e.message : String(e)}`, 'warn');
    } finally {
      this._modelSwitching = false;
      this._syncModelChip();
    }
  }

  _toggleDictation() {
    if (this._dictating) {
      this._stopDictation();
      return;
    }
    const Ctor = speechRecognitionCtor();
    if (!Ctor) {
      this.showToast('Voice input is not supported in this browser', 'warn');
      return;
    }
    if (!this._composerEnabled) return;
    let rec: any;
    try { rec = new Ctor(); }
    catch {
      this.showToast('Voice input is not supported in this browser', 'warn');
      return;
    }
    rec.interimResults = true;
    rec.continuous = true;
    rec.lang = (typeof navigator !== 'undefined' && navigator.language) || 'en-US';
    const ta = this.composerTa as HTMLTextAreaElement | null;
    const base = ta ? ta.value : '';
    const needsSpace = !!(base && !/\s$/.test(base));
    rec.onresult = (ev: any) => {
      if (!ta) return;
      let said = '';
      for (let i = 0; i < (ev.results ? ev.results.length : 0); i++) {
        const piece = ev.results[i] && ev.results[i][0] && ev.results[i][0].transcript;
        if (piece) said += piece;
      }
      ta.value = base + (needsSpace && said ? ' ' : '') + said;
      this._autosizeComposer();
      this._syncComposerBar();
    };
    rec.onerror = (ev: any) => {
      const err = ev && ev.error;
      if (err && err !== 'aborted' && err !== 'no-speech') {
        this.showToast(err === 'not-allowed'
          ? 'Microphone permission denied'
          : `Voice input failed: ${err}`, 'warn');
      }
      this._stopDictation();
    };
    rec.onend = () => this._stopDictation();
    this._recognition = rec;
    this._dictating = true;
    if (this.composerMicBtn) this.composerMicBtn.classList.add('is-listening');
    try { rec.start(); }
    catch (e: any) {
      this._stopDictation();
      this.showToast(e && e.message ? e.message : 'Voice input failed', 'warn');
    }
  }

  _stopDictation() {
    const rec = this._recognition;
    this._recognition = null;
    this._dictating = false;
    if (this.composerMicBtn) this.composerMicBtn.classList.remove('is-listening');
    if (!rec) return;
    try { rec.onresult = null; rec.onerror = null; rec.onend = null; } catch { /* ignore */ }
    try { rec.stop(); } catch { /* ignore */ }
  }

  setAgent(agent: any) {
    // agent: { id, ... } or null
    this.closeStream();
    this._cancelChatIntro();
    this.streamEl.replaceChildren();
    this.turns = [];
    this.activeTurn = null;
    this._historyWatermark = null;
    // Fire-and-forget skill cache warmup so the banner can paint as soon
    // as a /name message lands. Harmless if the agent has none.
    this._loadSkills();
    this.statusEl.textContent = '';
    this.palette.classList.add('hidden');
    this.palette.replaceChildren();
    this.toastHost.replaceChildren();
    this.composerTa.value = '';
    if (this.composerHint) {
      this.composerHint.classList.add('hidden');
      this.composerHint.textContent = '';
    }
    if (this.imageAttach) this.imageAttach.clear();
    this._suggestPinned = false;
    this._stopDictation();
    this._autosizeComposer();
    this._syncComposerBar();
    this._renderComposerSuggest();
    this._promptCapImage = false;
    this._syncAttachBtn();
    if (agent) this._captureAgentCaps(agent);

    if (!agent || !agent.id) {
      this.agentId = null;
      this.currentAgent = null;
      saveLastAgent(null);
      this.streamEl.appendChild(this.empty);
      this._setComposerEnabled(false);
      this._renderComposerSuggest();
      if (this.tokensPill)  this.tokensPill.hidden = true;
      if (this.inflightPill) this.inflightPill.hidden = true;
      if (this.chromeEl) this.chromeEl.hidden = true;
      this._publishTopbarContext();
      this._syncModelChip();
      return;
    }

    const switchingAgent = this.agentId !== agent.id;
    if (switchingAgent) {
      this._clearAllInFlight();
      this._activeTodoCard = null;
      this._skillsPromise = null;
      this._knownSkills = null;
    }
    this.agentId = agent.id;
    this.currentAgent = agent;
    if (this.chromeEl) this.chromeEl.hidden = false;
    this._publishTopbarContext();
    saveLastAgent(agent.id);
    this.latestTotalTokens = (agent && agent.totalTokens) || null;
    if (switchingAgent) this._lastRenderedTokens = 0;
    this._setComposerEnabled(!this._heldByTui(agent));
    this._setTurnBusyFromAgent(agent);
    this._syncHeldBy(agent);
    this._renderComposerSuggest();
    this._renderTokensPill();
    this._renderInflightPill();
    this._syncModelChip();
    void this._loadSkills();

    const agentIdAtCall = agent.id;
    this.refreshHistory()
      .catch((e) => this.showStatus(`history load failed: ${e.message}`, 'warn'))
      .finally(() => {
        if (
          this.agentId === agentIdAtCall &&
          (!this.turns || this.turns.length === 0) &&
          !this.activeTurn &&
          !this._chatIntroAbort
        ) {
          this._playChatIntro();
        }
        this.openStreamForCurrent();
        this._ensureConnected(agent);
      });
  }

  // ── chat intro animation ─────────────────────────────────────────────
  //
  // When a brand-new conversation is opened (zero turns), show the
  // Grok-Build → Grok-TUI welcome. It cancels when the first message
  // lands or the user switches away.

  _playChatIntro() {
    if (this._chatIntroAbort) return;
    this._chatIntroAbort = new AbortController();
    const wrapEl = buildChatWelcome('chat-intro');
    this._chatIntroEl = wrapEl;
    this.streamEl.replaceChildren(wrapEl);
  }

  _cancelChatIntro() {
    if (this._chatIntroAbort) {
      try { this._chatIntroAbort.abort(); } catch { /* ignore */ }
      this._chatIntroAbort = null;
    }
    if (this._chatIntroEl && this._chatIntroEl.parentNode) {
      try { this._chatIntroEl.parentNode.removeChild(this._chatIntroEl); } catch { /* ignore */ }
    }
    this._chatIntroEl = null;
  }

  async refreshHistory({ all = false, turns = 50 } = {}) {
    if (!this.agentId) return;
    this._historyAll = !!all;
    try {
      const hist: any = await api.history(this.agentId, { turns, all });
      const events: any[] = (hist && Array.isArray(hist.events)) ? hist.events : [];
      this.streamEl.replaceChildren();
      this.turns = [];
      this.activeTurn = null;
      // If there are older turns we didn't load, show a banner at the top.
      const total = (hist && hist.totalTurns) || 0;
      const returned = (hist && hist.returnedTurns) || 0;
      if (!all && total > returned && returned > 0) {
        this.streamEl.appendChild(this._buildLoadEarlierBanner(total - returned));
      }
      this._isReplaying = true;
      let watermark = 0;
      try {
        for (const ev of events) {
          const name = ev.event || ev.type || ev.name;
          const data = ev.data || ev.payload || ev;
          if (!name) continue;
          if (isReplayPayload(data) || isReplayPayload(ev)) continue;
          const t = eventTimeMs(ev) ?? eventTimeMs(data) ?? Date.parse(ev.at);
          if (Number.isFinite(t) && t > watermark) watermark = t;
          if (Number.isFinite(t)) this._lastEventTs = t;
          this.handleEvent(name, data, { fromHistory: true });
        }
      } finally {
        this._isReplaying = false;
      }
      this._historyWatermark = watermark || null;
      this._lastEventTs = null;
      // History replay may end with an unterminated turn (interrupted session,
      // or a prompt_complete that never made it to disk). Walk every turn and
      // finalize any thinking pane that is still in its active/blinking state
      // so the dots stop animating. Leave activeTurn open so a mid-flight
      // prompt can keep appending after the SSE watermark instead of opening
      // a new empty YOU bubble.
      for (const turn of this.turns) {
        if (turn.thinking && typeof turn.thinking.finalize === 'function') {
          turn.thinking.finalize();
        }
        this._finalizeLiveTools(turn);
      }
      // Scroll the stream to the bottom after a history load. Reset
      // auto-scroll: the user just opened the conversation, they want to be
      // at the latest message regardless of where the last session ended.
      this._autoScroll = true;
      if (this._jumpToLatestBtn) this._jumpToLatestBtn.hidden = true;
      requestAnimationFrame(() => {
        this.scrollToBottom({ force: true });
      });
      this._renderComposerSuggest();
    } catch (e) {
      // backend may not implement history yet
    }
  }

  _buildLoadEarlierBanner(missingCount: any) {
    const btn = el('button', {
      class: 'history-load-more-btn',
      type: 'button',
      onclick: async () => {
        btn.disabled = true;
        btn.textContent = 'loading...';
        await this.refreshHistory({ all: true });
      },
    }, `load all earlier turns (${missingCount} more)`);
    return el('div', { class: 'history-load-more' }, btn);
  }

  openStreamForCurrent() {
    if (!this.agentId) return;
    // Drop a leftover EventSource before opening another. visibilitychange
    // can call this while the previous handle is CLOSED but not nulled.
    this.closeStream();
    this._paintAgentStatus(this.currentAgent);
    this.stream = openStream(`/api/agents/${encodeURIComponent(this.agentId)}/stream`, {
      onOpen:  () => {
        this._clearStreamWarn();
        this._paintAgentStatus(this.currentAgent);
      },
      onError: () => {
        if (this.stream && this.stream.isClosed()) return;
        if (this._heldByTui(this.currentAgent)) {
          this._paintAgentStatus(this.currentAgent);
          return;
        }
        // EventSource fires `error` on every reconnect attempt, including
        // the first CONNECTING and brief Tailscale blips. Only warn if the
        // socket stays down past the server's retry: 2000 hint.
        if (this._streamWarnTimer) return;
        this._streamWarnTimer = setTimeout(() => {
          this._streamWarnTimer = null;
          if (!this.stream || this.stream.isClosed()) return;
          if (this.stream.readyState() === 1) return;
          this.showStatus('stream error · reconnecting', 'warn');
        }, 3500);
      },
      onAny:   (name, data) => this.handleEvent(name, data),
    });
  }

  _clearStreamWarn() {
    if (this._streamWarnTimer) {
      clearTimeout(this._streamWarnTimer);
      this._streamWarnTimer = null;
    }
  }

  closeStream() {
    this._clearStreamWarn();
    if (this.stream) {
      this.stream.close();
      this.stream = null;
    }
  }

  showStatus(text: any, kind?: any) {
    const msg = text == null ? '' : String(text);
    if (!msg) {
      this.statusEl.hidden = true;
      this.statusEl.replaceChildren();
      return;
    }
    const k = kind || 'idle';
    this.statusEl.hidden = false;
    this.statusEl.replaceChildren(
      el('span', { class: `status-pill status-pill--${k}` }, '·'),
      el('span', { class: 'chat-status-text' }, msg),
    );
    this.statusEl.dataset.kind = k;
    this.statusEl.classList.toggle('chat-status--quiet', k === 'ok' || k === 'idle');
  }

  showToast(text: any, kind?: any) {
    const toast = renderToast(text, kind);
    this.toastHost.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('toast--out');
      setTimeout(() => toast.remove(), 250);
    }, 4200);
  }

  // ── turn machinery ───────────────────────────────────────────────────

  ensureTurn() {
    if (this.activeTurn) return this.activeTurn;
    return this.startTurn('', { ts: this._lastEventTs || Date.now() });
  }

  _fillUserOnTurn(turn: any, userText: any, attachments: any, ts: any) {
    if (!turn || turn.user) return;
    const bubble = renderUserBubble(userText, ts, {
      attachments,
      agentId: this.agentId,
    });
    if (!bubble) return;
    turn.user = bubble;
    turn.userText = userText || '';
    turn.userAttachments = attachments || [];
    turn.root.insertBefore(bubble, turn.root.firstChild);
    this._decorateSkill(turn);
  }

  startTurn(userText: any, opts?: any) {
    // A turn is about to land in the stream. Cancel the welcome animation
    // if it's still running so it doesn't overlap the new bubble.
    this._cancelChatIntro();
    const ts = (opts && opts.ts) || Date.now();
    const attachments = Array.isArray(opts && opts.attachments) ? opts.attachments : [];
    const userBubble = shouldRenderUserBubble(userText, attachments)
      ? renderUserBubble(userText, ts, {
          attachments,
          agentId: this.agentId,
        })
      : null;
    // Only animate fresh insertions, never historical replay (that would
    // produce a chaotic shimmer across all replayed turns).
    const animate = !this._isReplaying && !(opts && opts.fromHistory);
    const classes = animate ? 'turn turn--enter' : 'turn';
    const root = el('div', { class: classes }, userBubble);
    this.streamEl.appendChild(root);
    const turn = {
      user:      userBubble,
      userText:  userText || '',
      userAttachments: attachments,
      thinking:  null,
      toolLog:   null,
      tools:     [],
      assistant: null,
      footer:    null,
      usageMeta: null,
      root,
    };
    if (this.activeTurn) this._finalizeLiveTools(this.activeTurn);
    this.turns.push(turn);
    this.activeTurn = turn;
    if (!(opts && opts.fromHistory)) this._renderComposerSuggest();
    // Decorate retroactively once the skill set is loaded. Idempotent.
    this._decorateSkill(turn);
    this.scrollToBottom();
    return turn;
  }

  _finalizeLiveTools(turn: any, meta?: any) {
    if (!turn || !Array.isArray(turn.tools) || !turn.tools.length) return;
    const stop = String((meta && (meta.stopReason || meta.stop_reason)) || '').toLowerCase();
    const implied = (stop === 'cancelled' || stop === 'canceled') ? 'canceled' : 'completed';
    let changed = false;
    for (const t of turn.tools) {
      const card = t && t.card;
      if (!card) continue;
      const status = card.getStatus ? card.getStatus() : '';
      if (isTerminalToolStatus(status)) {
        if (typeof card.finalize === 'function') card.finalize();
        continue;
      }
      if (typeof card.finalize === 'function') card.finalize(implied);
      else card.applyUpdate({ status: implied });
      changed = true;
    }
    if (changed && turn.toolLog && typeof turn.toolLog.refresh === 'function') {
      turn.toolLog.refresh();
    }
    this._resyncInFlightStrip();
  }

  endTurn(meta: any) {
    const incoming = extractTokenMeta(meta) || (hasTurnLedger(meta) ? meta : null);
    const merged = mergeTokenMeta(
      mergeTokenMeta(this.activeTurn && this.activeTurn.usageMeta, this._pendingUsage),
      incoming,
    );
    this._pendingUsage = null;

    const target = this.activeTurn || this.turns[this.turns.length - 1] || null;
    if (this.activeTurn) {
      if (this.activeTurn.thinking) this.activeTurn.thinking.finalize();
      if (this.activeTurn.assistant) this.activeTurn.assistant.finalize();
      this._finalizeLiveTools(this.activeTurn, meta);
      this._paintTurnFooter(this.activeTurn, merged);
      this.activeTurn = null;
      this.composerCancel.disabled = true;
      this._syncComposerBar();
      this.scrollToBottom();
      return;
    }
    // prompt_result / turn_completed often land after prompt_complete has
    // already closed the turn. Backfill the last footer's chips and stop
    // any work-row clocks that never got a terminal tool_call_update.
    if (target) {
      this._finalizeLiveTools(target, meta);
      this._paintTurnFooter(target, merged);
    }
  }

  _paintTurnFooter(turn: any, meta: any) {
    if (!turn) return;
    const next = mergeTokenMeta(turn.usageMeta, meta);
    if (hasTurnLedger(next)) turn.usageMeta = next;
    const total = next.totalTokens ?? next.total_tokens;
    if (typeof total === 'number' && Number.isFinite(total)) {
      this.latestTotalTokens = total;
      this._renderTokensPill();
      this._renderInflightPill();
    }
    // Don't replace a populated footer with an empty one (prompt_complete
    // after a turn_completed that already filled the chips).
    if (!hasTurnLedger(next)) return;
    const footer = renderTokenFooter(next);
    if (!footer) return;
    if (turn.footer && turn.footer.parentNode) {
      turn.footer.replaceWith(footer);
    } else if (turn.root) {
      turn.root.appendChild(footer);
    }
    turn.footer = footer;
  }

  _ingestTurnUsage(payload: any) {
    const meta = extractTokenMeta(payload);
    if (!meta || !hasTurnLedger(meta)) return;
    // Paint immediately — history replay never gets a later prompt_complete,
    // and live turn_completed often lands while activeTurn is still open.
    const target = this.activeTurn || this.turns[this.turns.length - 1] || null;
    if (target) {
      this._paintTurnFooter(target, meta);
      return;
    }
    this._pendingUsage = mergeTokenMeta(this._pendingUsage, meta);
  }

  scrollToBottom(opts?: any) {
    // Stay pinned to the bottom only when the user hasn't scrolled away.
    // Force-scroll on explicit actions (sending a message, initial load).
    const force = !!(opts && opts.force);
    if (!force && this._autoScroll === false) return;

    // Force path: snap to bottom (preserves content-visibility scrollIntoView
    // fallback). Used for initial history load and explicit user actions like
    // the jump-to-latest button.
    if (force) {
      // Cancel any in-flight eased loop so it doesn't fight the snap.
      if (this._easedScrollRaf) {
        cancelAnimationFrame(this._easedScrollRaf);
        this._easedScrollRaf = 0;
      }
      if (this._scrollRaf) return;
      this._scrollRaf = requestAnimationFrame(() => {
        this._scrollRaf = 0;
        const doScroll = () => {
          // content-visibility: auto on .turn makes scrollHeight unreliable
          // until the browser has actually rendered the off-screen turns. Use
          // scrollIntoView on the last child when forcing; it triggers the
          // lazy layout for any sibling on the way and lands accurately at
          // the very bottom.
          const last = this.streamEl.lastElementChild;
          if (last && typeof last.scrollIntoView === 'function') {
            try {
              last.scrollIntoView({ block: 'end' });
              this._lastEasedWrite = this.streamEl.scrollTop;
              return;
            } catch { /* fall through */ }
          }
          this.streamEl.scrollTop = this.streamEl.scrollHeight;
          this._lastEasedWrite = this.streamEl.scrollTop;
        };
        doScroll();
        // Re-run once more after layout has settled so we land on the true
        // bottom even after content-visibility realizes the placeholders.
        requestAnimationFrame(() => {
          doScroll();
          // Reset the eased target so it doesn't immediately yank us back
          // up if the next streaming chunk references a stale target.
          this._easedScrollTarget = this.streamEl.scrollTop;
        });
      });
      return;
    }

    // Streaming path: eased follow toward the current bottom. Each call just
    // re-arms the target; the single rAF loop in _easedScrollTick handles the
    // animation and self-cancels when it lands within 1px of the target.
    this._scheduleEasedScroll();
  }

  // Mark the stream as wanting to chase the bottom. Starts the rAF loop if
  // not already running. Safe to call repeatedly per chunk arrival.
  _scheduleEasedScroll() {
    this._easedScrollPending = true;
    if (typeof document !== 'undefined' && document.hidden) {
      // rAF is throttled when the tab is hidden. Snap instead so when the
      // user comes back they're already at the bottom.
      this.streamEl.scrollTop = this.streamEl.scrollHeight;
      this._lastEasedWrite = this.streamEl.scrollTop;
      this._easedScrollPending = false;
      this._easedScrollTarget = this.streamEl.scrollTop;
      return;
    }
    if (this._easedScrollRaf) return;
    const tick = () => {
      this._easedScrollRaf = 0;
      // Bail if the user scrolled away or the view got torn down between
      // frames.
      if (!this.streamEl || !this.streamEl.isConnected) return;
      if (this._autoScroll === false) {
        this._easedScrollPending = false;
        return;
      }
      const el = this.streamEl;
      const target = Math.max(0, el.scrollHeight - el.clientHeight);
      this._easedScrollTarget = target;
      const current = el.scrollTop;
      const delta = target - current;
      if (Math.abs(delta) <= 1) {
        // Land exactly and stop the loop.
        el.scrollTop = target;
        this._lastEasedWrite = target;
        this._easedScrollPending = false;
        return;
      }
      // Ease ~0.22 per frame. At 60fps a 200px gap closes in ~10 frames.
      const next = current + delta * 0.22;
      el.scrollTop = next;
      this._lastEasedWrite = next;
      this._easedScrollRaf = requestAnimationFrame(tick);
    };
    this._easedScrollRaf = requestAnimationFrame(tick);
  }

  // Eased follow for the tools column. Mirrors scrollToBottom() above but
  // for this.toolsStreamEl. Cheaper because the tools column doesn't use
  // content-visibility so scrollHeight is always accurate.
  _isChatMobile() {
    return window.innerWidth <= 720;
  }

  _autosizeComposer() {
    const ta = this.composerTa as HTMLTextAreaElement | null;
    if (!ta) return;
    ta.style.height = 'auto';
    const min = 24;
    const next = Math.min(Math.max(ta.scrollHeight, min), 160);
    ta.style.height = `${next}px`;
  }

  _placeToolCard(turn: any, card: any, settle = false) {
    if (!turn.toolLog) {
      turn.toolLog = renderToolLog();
      const before = (turn.assistant && turn.assistant.node) || turn.footer;
      if (before) turn.root.insertBefore(turn.toolLog.node, before);
      else turn.root.appendChild(turn.toolLog.node);
    }
    turn.toolLog.add(card, { settle });
  }

  _initAutoScroll() {
    this._autoScroll = true;
    this._autoScrollTools = true;
    const THRESHOLD = 60; // px from bottom counts as "at bottom"
    // Jump-to-latest button, hidden by default. Anchored to the composer
    // card so CSS can float it just above the input, top-right.
    this._jumpToLatestBtn = el('button', {
      type: 'button',
      class: 'jump-to-latest',
      hidden: true,
      title: 'Jump to latest',
      'aria-label': 'Jump to latest',
      html: iconHtml('chevron-down'),
      onclick: () => {
        this._autoScroll = true;
        this.scrollToBottom({ force: true });
        this._jumpToLatestBtn.hidden = true;
      },
    });
    if (this.composerCard && !this.composerCard.contains(this._jumpToLatestBtn)) {
      this.composerCard.appendChild(this._jumpToLatestBtn);
    }
    // Track user-initiated scroll. We need to distinguish programmatic
    // eased-scroll writes from real user input; a manual flag set just
    // before each programmatic write would be racy across rAF boundaries,
    // so instead we compare against the most-recent eased target. If the
    // user is meaningfully off-target (more than the threshold), treat it
    // as a manual scroll-away.
    const onScroll = () => {
      const el = this.streamEl;
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      const atBottom = dist <= THRESHOLD;
      // While the eased loop is chasing the bottom, it writes scrollTop
      // mid-flight (still well above the bottom). Those writes raise
      // scroll events that look identical to user scroll-aways. Suppress
      // them by skipping when the eased loop is active AND we're moving
      // toward the bottom (not away).
      if (this._easedScrollRaf && !atBottom) {
        // Currently being pulled toward bottom by our own loop. Trust the
        // loop to keep going; only a clear "user moved further from
        // bottom than our last write" should pause auto-scroll.
        if (this._lastEasedWrite != null && el.scrollTop >= this._lastEasedWrite - 4) {
          return;
        }
      }
      if (atBottom && !this._autoScroll) {
        this._autoScroll = true;
        this._jumpToLatestBtn.hidden = true;
      } else if (!atBottom && this._autoScroll) {
        this._autoScroll = false;
        this._jumpToLatestBtn.hidden = false;
        // Stop chasing while the user is reading further up.
        if (this._easedScrollRaf) {
          cancelAnimationFrame(this._easedScrollRaf);
          this._easedScrollRaf = 0;
        }
      }
    };
    this.streamEl.addEventListener('scroll', onScroll, { passive: true });

    const onVis = () => {
      if (document.hidden) return;
      if (this._autoScroll !== false) {
        this.streamEl.scrollTop = this.streamEl.scrollHeight;
        this._easedScrollTarget = this.streamEl.scrollTop;
        this._lastEasedWrite = this.streamEl.scrollTop;
      }
    };
    document.addEventListener('visibilitychange', onVis);

    this._detachAutoScroll = () => {
      this.streamEl.removeEventListener('scroll', onScroll);
      document.removeEventListener('visibilitychange', onVis);
      if (this._easedScrollRaf) { cancelAnimationFrame(this._easedScrollRaf); this._easedScrollRaf = 0; }
    };
  }

  // ── in-flight strip ──────────────────────────────────────────────────

  _addInFlight(data: any, cardNode: any) {
    if (!data || !data.toolCallId) return;
    if (this._inFlightMap.has(data.toolCallId)) return;
    const label = (data.rawInput && (data.rawInput.command || data.rawInput.path || data.rawInput.file_path || data.rawInput.url))
                || data.title
                || data.kind
                || 'tool';
    const kind = data.kind || 'tool';
    const startedAt = Date.now();
    const chip = el('button', {
      type: 'button',
      class: 'inflight-chip',
      title: `${kind} · ${label}`,
      onclick: () => {
        // Scroll the card into view and pulse it briefly so the user can
        // confirm which one in the stream it maps to.
        if (cardNode && cardNode.scrollIntoView) {
          cardNode.scrollIntoView({ behavior: 'smooth', block: 'center' });
          cardNode.classList.add('tool-pill--highlight');
          setTimeout(() => cardNode.classList.remove('tool-pill--highlight'), 1200);
        }
      },
    },
      el('span', { class: 'inflight-chip__dot' }),
      el('span', { class: 'inflight-chip__kind' }, kind),
      el('span', { class: 'inflight-chip__label' }, String(label)),
      el('span', { class: 'inflight-chip__dur' }, '0s'),
    );
    this._inFlightMap.set(data.toolCallId, { kind, label, startedAt, chip });
    this.inFlightStripEl.appendChild(chip);
    this._syncInFlightVisibility();
    this._startInFlightTicker();
  }

  _removeInFlight(toolCallId: any) {
    const entry = this._inFlightMap.get(toolCallId);
    if (!entry) return;
    entry.chip.remove();
    this._inFlightMap.delete(toolCallId);
    this._syncInFlightVisibility();
    if (this._inFlightMap.size === 0 && this._inFlightTimer) {
      clearInterval(this._inFlightTimer);
      this._inFlightTimer = null;
    }
  }

  _clearAllInFlight() {
    this._inFlightMap.clear();
    this.inFlightStripEl.replaceChildren();
    this._syncInFlightVisibility();
    if (this._inFlightTimer) {
      clearInterval(this._inFlightTimer);
      this._inFlightTimer = null;
    }
  }

  _syncInFlightVisibility() {
    this.inFlightStripEl.hidden = this._inFlightMap.size === 0;
  }

  // ── in-flight chip duration ticker ───────────────────────────────────

  _startInFlightTicker() {
    if (this._inFlightTimer) return;
    this._inFlightTimer = setInterval(() => {
      const now = Date.now();
      for (const entry of this._inFlightMap.values()) {
        const ms = now - entry.startedAt;
        const durEl = entry.chip.querySelector('.inflight-chip__dur');
        if (!durEl) continue;
        if (ms < 1000) durEl.textContent = `${Math.round(ms)}ms`;
        else if (ms < 60000) durEl.textContent = `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
        else {
          const m = Math.floor(ms / 60000);
          const s = Math.round((ms % 60000) / 1000);
          durEl.textContent = `${m}m${s ? ` ${s}s` : ''}`;
        }
      }
      // Self-heal: walk the rendered pills and drop any stale chip whose
      // card has reached terminal status without us having seen the event.
      this._resyncInFlightStrip();
    }, 500);
  }

  // ── event dispatch ──────────────────────────────────────────────────

  handleEvent(name: any, payload: any, opts?: any) {
    const fromHistory = !!(opts && opts.fromHistory);
    if (isReplayPayload(payload)) return;
    if (!fromHistory && isStaleLiveEvent(payload, this._historyWatermark)) return;
    const data = unwrap(payload);
    switch (name) {
      case 'user_message':              return this.onUserMessage(data, opts);
      case 'user_message_chunk':        return this.onUserMessageChunk(data, opts);
      case 'agent_message_chunk':       return this.onMessageChunk(data, opts);
      case 'agent_thought_chunk':       return this.onThoughtChunk(data, opts);
      case 'tool_call':                 return this.onToolCall(data, opts);
      case 'tool_call_update':          return this.onToolCallUpdate(data, opts);
      case 'tool_call_delta_chunk':     return this.onToolCallDelta(data);
      case 'available_commands_update': return this.onAvailableCommands(data);
      case 'handshake':                 return this.onHandshake(data);
      case 'session_summary_generated': return this.onSessionSummary(data);
      case 'prompt_complete':           return this.onPromptComplete(data);
      case 'prompt_result':             return this.onPromptResult(data);
      case 'turn_completed':            return this.onTurnCompleted(data);
      case 'x.ai/session/update':       return this.onXSessionUpdate(payload);
      case 'agent_status':              return this.onAgentStatus(data);
      case 'session_notification':      return this.onSessionNotification(data);
      case 'error':                     return this.onError(data);
      default: return;
    }
  }

  onUserMessageChunk(data: any, opts?: any) {
    const text = extractText(data);
    if (!text) return;
    const turn = this.activeTurn;
    const canAppend = !!(turn
      && !turn.assistant
      && !turn.thinking
      && (!turn.tools || !turn.tools.length));
    if (!canAppend) {
      this.startTurn(text, {
        ts: this._lastEventTs || Date.now(),
        fromHistory: !!(opts && opts.fromHistory),
      });
      return;
    }
    turn.userText = (turn.userText || '') + text;
    const body = turn.user && turn.user.querySelector && turn.user.querySelector('.msg-body');
    if (body) body.replaceChildren(renderMarkdownLight(turn.userText || ''));
    this.scrollToBottom();
  }

  onUserMessage(data: any, opts?: any) {
    if (isNonTextUserContent(data)) return;
    const text = (data && typeof data.text === 'string') ? data.text : extractText(data);
    const attachments = Array.isArray(data && data.attachments) ? data.attachments : [];
    if (!text && !attachments.length) return;
    const ts = this._lastEventTs || Date.now();
    // Dedup: the live send() path calls startTurn(text) BEFORE the server
    // echoes user_message back over SSE. If the active turn already has the
    // same userText and no assistant/tools yet, the bubble is already there.
    if (
      this.activeTurn &&
      (userTextsMatch(this.activeTurn.userText, text) ||
        ((this.activeTurn.userAttachments || []).length && attachments.length)) &&
      !this.activeTurn.assistant &&
      (!this.activeTurn.tools || !this.activeTurn.tools.length)
    ) {
      if (!this.activeTurn.user && shouldRenderUserBubble(text, attachments)) {
        this._fillUserOnTurn(this.activeTurn, text, attachments, ts);
      }
      return;
    }
    // session/load and ring catch-up re-emit prior user turns after
    // prompt_complete has already closed activeTurn. Skip those copies.
    if (hasMatchingUserTurn(this.turns, text)) return;
    // A thought/tool may have opened an empty shell via ensureTurn(). Fill
    // that shell instead of stacking a second YOU.
    if (
      this.activeTurn &&
      !this.activeTurn.user &&
      !this.activeTurn.assistant &&
      (!this.activeTurn.tools || !this.activeTurn.tools.length)
    ) {
      this._fillUserOnTurn(this.activeTurn, text, attachments, ts);
      return;
    }
    this.startTurn(text, {
      ts,
      fromHistory: !!(opts && opts.fromHistory),
      attachments,
    });
  }

  onMessageChunk(data: any, opts?: any) {
    const text = extractText(data);
    if (text == null) return;
    const turn = this.ensureTurn();
    const fresh = !turn.assistant;
    if (fresh) {
      turn.assistant = renderAssistantBubble(this._lastEventTs || Date.now());
      // Mark the assistant bubble for entrance animation only on first
      // insertion in the live path (skip during history replay).
      if (!this._isReplaying && !(opts && opts.fromHistory)) {
        turn.assistant.node.classList.add('msg--enter');
      }
      turn.root.appendChild(turn.assistant.node);
    }
    turn.assistant.append(text);
    this.scrollToBottom();
  }

  onThoughtChunk(data: any, opts?: any) {
    const text = extractText(data);
    if (text == null) return;
    const turn = this.ensureTurn();
    if (!turn.thinking) {
      turn.thinking = renderThinkingPane();
      const before = (turn.toolLog && turn.toolLog.node)
        || (turn.assistant && turn.assistant.node)
        || turn.footer;
      if (before) turn.root.insertBefore(turn.thinking.node, before);
      else turn.root.appendChild(turn.thinking.node);
    }
    turn.thinking.append(text);
    this.scrollToBottom();
  }

  // Coalesce TodoWrite tool calls so a checklist evolves in place
  // instead of stacking a new pill per merge=true patch. Returns true
  // when the call was absorbed (caller should NOT also create a pill).
  //
  // Rules:
  //   - rawInput.merge === false (or no prior active card) → start a
  //     fresh card. Falls through to the normal pill path; we just stash
  //     the reference so later merges can find it.
  //   - rawInput.merge === true and we have an active card → patch the
  //     existing card and stop. No new pill, no strip chip.
  _maybeRouteTodoToolCall(data: any, opts?: any) {
    if (!isTodoWriteToolCall(data)) return false;
    const ri = data.rawInput || {};
    const isMerge = !!ri.merge;

    // Merge update with an active todo card already: absorb in place.
    if (isMerge && this._activeTodoCard && typeof this._activeTodoCard.ingestExternal === 'function') {
      this._activeTodoCard.ingestExternal(data);
      const host = this.activeTurn || this.turns[this.turns.length - 1];
      if (host && host.toolLog && typeof host.toolLog.refresh === 'function') host.toolLog.refresh();
      return true;
    }

    // grok often emits the initial tool_call event WITHOUT rawInput,
    // then fills it in on a subsequent tool_call_update. By that point
    // we've already created a regular card. Swap it for a todo card
    // in place so the user sees the checklist, not raw JSON.
    const turn = this.activeTurn || this.turns[this.turns.length - 1];
    if (turn && data.toolCallId) {
      const entry = turn.tools.find((t: any) => t.id === data.toolCallId);
      if (entry && entry.card && !entry.card.isTodo) {
        const next = renderTodoWriteCard(data);
        if (turn.toolLog && typeof turn.toolLog.replace === 'function') {
          turn.toolLog.replace(entry.card, next);
        } else if (entry.card.node && entry.card.node.parentNode) {
          entry.card.node.parentNode.replaceChild(next.node, entry.card.node);
        }
        entry.card = next;
        this._activeTodoCard = next;
        // Drop any in-flight chip the old regular card had registered;
        // todo cards don't participate in the strip.
        try { this._removeInFlight(data.toolCallId); } catch { /* ignore */ }
        return true;
      }
      // An existing todo card with the same id getting a non-merge
      // update: just re-ingest. Covers the rare case of grok re-seeding
      // the list mid-conversation.
      if (entry && entry.card && entry.card.isTodo) {
        entry.card.applyUpdate(data);
        this._activeTodoCard = entry.card;
        if (turn.toolLog && typeof turn.toolLog.refresh === 'function') turn.toolLog.refresh();
        return true;
      }
    }

    // No existing entry: let the normal creation path run and tag the
    // resulting card as the active todo (renderToolCard will dispatch
    // to renderTodoWriteCard when rawInput.variant is present).
    this._pendingTodoSeed = true;
    return false;
  }

  onToolCall(data: any, opts?: any) {
    // TodoWrite tool calls coalesce into a single live-updating card
    // (see _maybeRouteTodoToolCall). Subsequent calls with merge=true
    // are absorbed by the previous card instead of producing siblings.
    if (this._maybeRouteTodoToolCall(data, opts)) return;

    const turn = this.ensureTurn();
    const live = !this._isReplaying && !(opts && opts.fromHistory);
    const card = renderToolCard(data, { live });
    turn.tools.push({ id: data.toolCallId, card });
    if (live) card.node.classList.add('tool-pill--enter');
    this._placeToolCard(turn, card, live);
    // Add to the in-flight strip unless this came from history replay
    // (those calls are already terminal and would just flash). Skip
    // entirely for todo cards: they aren't interesting work in flight.
    if (live && !card.isTodo) {
      this._addInFlight(data, card.node);
    }
    if (this._pendingTodoSeed) {
      this._activeTodoCard = card;
      this._pendingTodoSeed = false;
    }
    this.scrollToBottom();
  }

  onToolCallUpdate(data: any, opts?: any) {
    if (this._maybeRouteTodoToolCall(data, opts)) return;

    const turn = this.activeTurn || this.turns[this.turns.length - 1];
    if (!turn) return;
    let entry = turn.tools.find((t: any) => t.id === data.toolCallId);
    if (entry) {
      entry.card.applyUpdate(data);
      if (turn.toolLog && typeof turn.toolLog.refresh === 'function') turn.toolLog.refresh();
    } else {
      // server might emit an update before we ever saw a tool_call. create one.
      const live = !this._isReplaying && !(opts && opts.fromHistory);
      const card = renderToolCard(data, { live });
      turn.tools.push({ id: data.toolCallId, card });
      if (live) card.node.classList.add('tool-pill--enter');
      this._placeToolCard(turn, card, live);
      if (live && !card.isTodo) this._addInFlight(data, card.node);
      if (this._pendingTodoSeed) {
        this._activeTodoCard = card;
        this._pendingTodoSeed = false;
      }
      entry = turn.tools[turn.tools.length - 1];
    }
    // Always reconcile the strip against the actual pill statuses. This is
    // robust to wire-format variations: whatever rendered the pill as
    // COMPLETED also drains its chip from the strip.
    this._resyncInFlightStrip();

    // If a file-mutating tool (Write / Edit / MultiEdit, all kind: 'edit')
    // just completed, ping the Files panel so it can re-list. Skipped while
    // replaying history because the disk is already in its final state and
    // a flurry of refreshes during catch-up wastes IO. The event carries
    // the agent id so the listener can ignore updates from a stale mount.
    if (!this._isReplaying && this.agentId) {
      const status = String((data && data.status) || '').toLowerCase();
      const kind   = String((data && data.kind)   || '').toLowerCase();
      if (status === 'completed' && kind === 'edit') {
        document.dispatchEvent(new CustomEvent('grok-remote:files-changed', {
          detail: { agentId: this.agentId, toolCallId: data.toolCallId },
        }));
      }
    }
  }

  // Walk the current turn's tools and drop any strip chips whose card has
  // reached a terminal status. Cheap (small N) and self-healing if an
  // intermediate event was missed.
  _resyncInFlightStrip() {
    if (!this._inFlightMap.size) return;
    // Collect all currently-rendered tool ids across all turns since strip
    // chips can outlive a single turn boundary.
    const liveByActive = new Map(); // id -> status string (lowercased)
    for (const turn of this.turns) {
      for (const t of (turn.tools || [])) {
        const s = (t.card && t.card.getStatus && t.card.getStatus() || '').toLowerCase();
        liveByActive.set(t.id, s);
      }
    }
    for (const tid of Array.from(this._inFlightMap.keys())) {
      const s = liveByActive.get(tid);
      // Gone from any turn (shouldn't happen, but defensive) or terminal: drop.
      if (s == null || isTerminalToolStatus(s)) {
        this._removeInFlight(tid);
      }
    }
  }

  onToolCallDelta(data: any) {
    const turn = this.activeTurn || this.turns[this.turns.length - 1];
    if (!turn || !turn.tools.length) return;
    // append to most-recent open tool card
    let target = null;
    for (let i = turn.tools.length - 1; i >= 0; i--) {
      const status = turn.tools[i].card.getStatus();
      if (status !== 'completed' && status !== 'failed') { target = turn.tools[i]; break; }
    }
    if (!target) target = turn.tools[turn.tools.length - 1];
    if (data && data.toolCallId) {
      const exact = turn.tools.find((t: any) => t.id === data.toolCallId);
      if (exact) target = exact;
    }
    target.card.appendDelta(data);
    this.scrollToBottom();
  }

  onAvailableCommands(data: any) {
    const list = (data && data.availableCommands) || data && data.commands || data;
    if (Array.isArray(list)) this.setAvailableCommands(list);
  }

  onHandshake(data: any) {
    // Agent-manager forwards { meta, agentCapabilities } as the SSE payload.
    const caps = data && (data.agentCapabilities || data.agent_capabilities);
    const pc = caps && caps.promptCapabilities;
    if (pc && typeof pc.image === 'boolean') {
      const before = !!this._promptCapImage;
      this._promptCapImage = !!pc.image;
      if (before !== this._promptCapImage) {
        this._syncAttachBtn();
        if (this.imageAttach) this.imageAttach.refreshSupport();
        // If the new model dropped image support, surface a clear warning.
        const atts = this.imageAttach ? this.imageAttach.getAttachments() : [];
        if (!this._promptCapImage && atts.length) {
          this.showToast('Active model no longer supports image input. Remove attachments to send.', 'warn');
        }
      }
    }
  }

  onSessionSummary(data: any) {
    const text = (data && (data.summary || data.text)) || '';
    const pill = renderCompactedPill(text);
    this.streamEl.appendChild(pill);
    this.scrollToBottom();
  }

  onPromptComplete(data: any) {
    const usage = extractTokenMeta(data);
    const bag = (data && data._meta) || data || {};
    const meta = mergeTokenMeta(usage, bag);
    if (meta && (meta.totalTokens != null || meta.total_tokens != null)) {
      this.latestTotalTokens = meta.totalTokens ?? meta.total_tokens;
      this._renderTokensPill();
      this._renderInflightPill();
    }
    // The turn is done; any tools that didn't get a terminal update were
    // implicitly completed (or aborted). Clear the strip so it doesn't
    // show ghost activity between turns.
    this._clearAllInFlight();
    // Capture sessionId/cwd from prompt_complete meta if the agent record is
    // missing it (handshake metadata is sometimes delivered out of band).
    if (this.currentAgent) {
      const sessionId = bag.sessionId || (data && data.sessionId);
      const modelId = (meta && (meta.modelId || meta.model_id || meta.model)) || bag.modelId;
      if (sessionId && !this.currentAgent.sessionId) {
        this.currentAgent.sessionId = sessionId;
      }
      if (modelId && !this.currentAgent.model) {
        this.currentAgent.model = modelId;
      }
      this._publishTopbarContext();
    }
    this.endTurn(meta);
  }

  onPromptResult(data: any) {
    this.endTurn(data);
  }

  onTurnCompleted(data: any) {
    this._ingestTurnUsage(data);
  }

  onXSessionUpdate(payload: any) {
    // unwrap() would drop params._meta / params.update.usage, so read the
    // raw envelope. Only turn_completed carries the token ledger.
    if (!isTurnCompletedPayload(payload) && !isTurnCompletedPayload(unwrap(payload))) return;
    this._ingestTurnUsage(payload);
  }

  onAgentStatus(data: any) {
    const status = data && (data.status || data.state);
    if (!status) return;
    if (status === 'starting') {
      this.showStatus('connecting...', 'idle');
    } else if (status === 'running') {
      this.showStatus('agent is running', 'warn');
      this.composerCancel.disabled = false;
    } else if (status === 'idle') {
      this.showStatus('idle', 'ok');
      if (!this.activeTurn) this.composerCancel.disabled = true;
    } else if (status === 'disconnected' || status === 'exited' || status === 'killed') {
      this.showStatus(status, status === 'disconnected' ? 'idle' : 'fail');
      this.composerCancel.disabled = true;
    } else if (status === 'errored') {
      this.showStatus('errored', 'fail');
      this.composerCancel.disabled = true;
    } else {
      this.showStatus(status, 'idle');
    }
  }

  onSessionNotification(data: any) {
    const text = (data && (data.message || data.text)) || JSON.stringify(data).slice(0, 200);
    this.showToast(text, 'info');
  }

  onError(data: any) {
    const text = errorBannerText(data);
    if (!text) return;
    const turn = this.activeTurn || this.ensureTurn();
    turn.root.appendChild(renderErrorBanner(text));
    this.scrollToBottom();
  }

  // ── composer actions ────────────────────────────────────────────────

  async send() {
    if (!this.agentId) return;
    if (this._heldByTui(this.currentAgent)) {
      this.showToast('TUI is using this session. Send from the terminal, or leave that chat first.', 'warn');
      return;
    }
    const text = this.composerTa.value.trim();
    const attachments = this.imageAttach ? this.imageAttach.getAttachments() : [];
    if (!text && !attachments.length) return;

    this.composerTa.value = '';
    if (this.composerHint) {
      this.composerHint.classList.add('hidden');
      this.composerHint.textContent = '';
    }
    this.palette.classList.add('hidden');
    this._suggestPinned = false;
    this._stopDictation();
    this._autosizeComposer();
    this._syncComposerBar();
    this._renderComposerSuggest();

    // Start a turn locally and let the SSE stream fill in the rest.
    // The user just sent a message; they want to see it land, so re-enable
    // auto-scroll regardless of where they were in the history.
    this._autoScroll = true;
    if (this._jumpToLatestBtn) this._jumpToLatestBtn.hidden = true;
    this.startTurn(text, { attachments });
    this.scrollToBottom({ force: true });
    this.composerCancel.disabled = false;

    try {
      const resp = await api.prompt(this.agentId, { text, attachments });
      this._lastServerEcho = resp && typeof resp === 'object' ? resp : null;
      if (this.imageAttach) this.imageAttach.clear();
    } catch (e: any) {
      this.activeTurn && this.activeTurn.root.appendChild(renderErrorBanner(e.message));
      this.endTurn(null);
    }
  }

  async cancel() {
    if (!this.agentId) return;
    try {
      await api.cancel(this.agentId);
      this.showToast('cancel requested', 'warn');
    } catch (e: any) {
      this.showToast(`cancel failed: ${e.message}`, 'warn');
    }
  }

}

// `unwrap` and `extractText` moved to ../lib/acp-payload.ts so they're
// typed + unit-testable. Imported above.
