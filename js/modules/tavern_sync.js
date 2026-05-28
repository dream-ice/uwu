// --- 酒馆互联模块 (js/modules/tavern_sync.js) ---

// 默认时间提取正则（命名捕获组）：从酒馆楼层文本里抓剧情时间
// 必需：year / month / day / hour / minute
// 可选：weekday / location / weather / mood（缺失则继承上一楼）
const DEFAULT_TIME_REGEX = String.raw`【\s*(?<year>\d{4})\s*年\s*(?<month>\d{1,2})\s*月\s*(?<day>\d{1,2})\s*日\s*(?<hour>\d{1,2})\s*[:：]\s*(?<minute>\d{2})\s*(?<weekday>星期[一二三四五六日天])?\s*(?:\|(?<location>[^|】]*)\|(?<weather>[^|】]*)\|(?<mood>[^】]*))?】?`;

const TavernSync = {
    DEFAULT_TIME_REGEX,

    getConfig() {
        if (!db.tavernSync || typeof db.tavernSync !== 'object') {
            db.tavernSync = { enabled: false, bindings: [], maxInjectMessages: 50, cleanRules: [], worldBookPosition: 'before_chat', pushIncludeStatusBar: true };
        }
        // 确保关键字段存在（防止旧数据缺少新字段）
        if (!Array.isArray(db.tavernSync.bindings)) db.tavernSync.bindings = [];
        if (!Array.isArray(db.tavernSync.cleanRules)) db.tavernSync.cleanRules = [];
        if (typeof db.tavernSync.pushIncludeStatusBar !== 'boolean') db.tavernSync.pushIncludeStatusBar = true;
        if (typeof db.tavernSync.timeRegex !== 'string' || !db.tavernSync.timeRegex.trim()) db.tavernSync.timeRegex = DEFAULT_TIME_REGEX;
        if (typeof db.tavernSync.injectFavoritedJournals !== 'boolean') db.tavernSync.injectFavoritedJournals = true;
        if (typeof db.tavernSync.injectUserFloors !== 'boolean') db.tavernSync.injectUserFloors = true;
        return db.tavernSync;
    },

    // 编译用户自定义时间正则；失败回退默认。返回 RegExp（一定可用）
    compileTimeRegex(source) {
        const src = (source && String(source).trim()) || DEFAULT_TIME_REGEX;
        try { return new RegExp(src); }
        catch (e) {
            console.warn('[TavernSync] 自定义时间正则无效，回退默认:', e.message);
            try { return new RegExp(DEFAULT_TIME_REGEX); } catch { return /(?!)/; }
        }
    },

    async saveConfig(config) {
        db.tavernSync = config;
        await saveData();
        console.log('[TavernSync] Config saved, bindings:', (config.bindings || []).length);
    },

    // ========== API ==========
    // 作为 ST 扩展运行时，与 ST 同源，浏览器自动带 session cookie。
    // 但 ST 启用了 CSRF，需要在每个 POST 里带 X-CSRF-Token 头。
    _csrfToken: null,
    async _getCsrfToken() {
        if (this._csrfToken) return this._csrfToken;
        try {
            const r = await fetch('/csrf-token', { credentials: 'same-origin' });
            if (r.ok) {
                const j = await r.json();
                this._csrfToken = j.token || '';
            }
        } catch (e) { console.warn('[TavernSync] 获取 CSRF token 失败:', e.message); }
        return this._csrfToken || '';
    },
    async _stFetch(url, opts = {}) {
        const token = await this._getCsrfToken();
        const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
        if (token) headers['X-CSRF-Token'] = token;
        return fetch(url, Object.assign({ credentials: 'same-origin' }, opts, { headers }));
    },

    async getUserList() {
        const resp = await this._stFetch('/api/users/list', { method: 'POST', body: '{}' });
        if (resp.status === 204) return [];
        if (!resp.ok) throw new Error(`获取用户列表失败: ${resp.status}`);
        return resp.json();
    },

    async login(handle, password) {
        const body = { handle };
        if (password) body.password = password;
        const resp = await this._stFetch('/api/users/login', { method: 'POST', body: JSON.stringify(body) });
        if (!resp.ok) { const err = await resp.json().catch(() => ({})); throw new Error(err.error || `登录失败: ${resp.status}`); }
        return resp.json();
    },

    async apiCall(endpoint, body = {}) {
        const resp = await this._stFetch(`${endpoint}`, { method: 'POST', body: JSON.stringify(body) });
        if (resp.status === 403) throw new Error('未登录或会话过期，请刷新页面');
        if (!resp.ok) throw new Error(`API ${resp.status}`);
        return resp.json();
    },

    async testConnection() {
        try { const chars = await this.apiCall('/api/characters/all', {}); return { ok: true, count: chars.length }; }
        catch (e) { return { ok: false, error: e.message }; }
    },

    async getSTCharacters() { return this.apiCall('/api/characters/all', {}); },
    async getSTCharacter(avatar) { return this.apiCall('/api/characters/get', { avatar_url: avatar }); },
    async getSTChats(avatar) { return this.apiCall('/api/characters/chats', { avatar_url: avatar, simple: true }); },
    async getSTChatMessages(avatar, file) { return this.apiCall('/api/chats/get', { avatar_url: avatar, file_name: file }); },
    async getSTWorldInfo(name) { return this.apiCall('/api/worldinfo/get', { name }); },
    async getSTSettings() {
        const resp = await this.apiCall('/api/settings/get', {});
        if (typeof resp.settings === 'string') return JSON.parse(resp.settings);
        return resp.settings || resp;
    },

    // ========== 正则清洗 ==========

    /**
     * @param {string} text - 消息文本
     * @param {number|null} depth - 消息深度（0 = 最新一条，1 = 倒数第二条…），null 表示不过滤深度
     */
    applyCleanRules(text, depth) {
        if (!text || typeof text !== 'string') return '';
        const config = this.getConfig();
        const rules = (config.cleanRules || []).filter(r => r.enabled);
        let result = text;
        for (const rule of rules) {
            // 深度过滤：规则可设置 minDepth / maxDepth 限定生效范围
            if (depth != null) {
                if (rule.minDepth != null && depth < rule.minDepth) continue;
                if (rule.maxDepth != null && depth > rule.maxDepth) continue;
            }
            try {
                const regex = new RegExp(rule.regex, 'gs');
                if (rule.mode === 'extract') {
                    const matches = [...result.matchAll(regex)];
                    if (matches.length) result = matches.map(m => m[1] !== undefined ? m[1] : m[0]).join('\n');
                } else {
                    result = result.replace(regex, '');
                }
            } catch (e) { console.warn(`[TavernSync] Invalid regex "${rule.name}":`, e.message); }
        }
        return result.trim();
    },

    // ========== 同步操作 ==========

    async pullFromTavern(binding) {
        const char = db.characters.find(c => c.id === binding.uwuCharId);
        if (!char) throw new Error('找不到角色');
        const msgs = await this.getSTChatMessages(binding.stCharAvatar, binding.stChatFile);
        if (!Array.isArray(msgs) || !msgs.length) return { imported: 0 };
        const config = this.getConfig();
        // 过滤掉 uwu 创建的纯推送楼层（拉回来会重复），保留合并到已有楼层的消息
        // 同时过滤酒馆隐藏楼层（is_system=true，即幽灵图标标记的消息，不发送给AI）
        let validMsgs = msgs.filter(m => m.mes?.trim() && !m.extra?.uwu_created && !m.is_system);
        if (config.maxInjectMessages > 0) validMsgs = validMsgs.slice(-config.maxInjectMessages);
        const total = validMsgs.length;

        // 用户自定义时间正则（默认：当前 OVO 标准格式）
        const timeRegex = this.compileTimeRegex(config.timeRegex);
        const pad2 = (x) => String(x).padStart(2, '0');

        // 隐藏楼层级联：在【全部】楼层里找最后一条 is_system=true 的剧情时间 → 之前的 OVO 历史也要跟着藏
        // 注意要看完整 msgs（不是 validMsgs），因为 validMsgs 已经把 is_system 过掉了
        let hiddenCutoffStoryTime = null;
        for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i];
            if (!m.is_system) continue;
            const tm = (m.mes || '').match(timeRegex);
            if (!tm || !tm.groups) continue;
            const { year: Y, month: Mo, day: D, hour: H, minute: Mi } = tm.groups;
            if (!Y || !Mo || !D || !H || !Mi) continue;
            hiddenCutoffStoryTime = `${Y}-${pad2(Mo)}-${pad2(D)} ${pad2(H)}:${pad2(Mi)}`;
            break;
        }

        // 结构化楼层：用 timeRegex 抓时间和场景
        // 必需命名组：year/month/day/hour/minute；可选：weekday/location/weather/mood
        // 可选组缺失（如 AI 偶尔只写半截时间括号）→ 标记 _partial，从 lastMeta 继承场景，时间用本楼新值
        const parseFloorMeta = (text) => {
            if (!text) return null;
            const m = text.match(timeRegex);
            if (!m || !m.groups) return null;
            const g = m.groups;
            const Y = g.year, Mo = g.month, D = g.day, H = g.hour, Mi = g.minute;
            if (!Y || !Mo || !D || !H || !Mi) return null;
            const loc = (g.location || '').trim();
            const weather = (g.weather || '').trim();
            const mood = (g.mood || '').trim();
            const isPartial = !loc && !weather && !mood;
            return {
                storyTime: `${Y}-${pad2(Mo)}-${pad2(D)} ${pad2(H)}:${pad2(Mi)}`,
                parsedTs: new Date(Number(Y), Number(Mo) - 1, Number(D), Number(H), Number(Mi)).getTime(),
                weekday: (g.weekday || '').trim(),
                location: loc,
                weather,
                mood,
                _partial: isPartial,
            };
        };

        const floors = [];
        const memoryLines = [];
        let lastMeta = null;
        let parsedCount = 0;
        validMsgs.forEach((m, i) => {
            const depth = total - 1 - i; // 0 = 最新，越大越旧
            const name = m.is_user ? (char.myName || '我') : (char.realName || char.name);
            // 合并楼层中去掉 <phone_chat> 部分，只保留原始酒馆内容
            let text = m.mes;
            if (m.extra?.from_uwu && !m.extra?.uwu_created) {
                text = text.replace(/<phone_chat>[\s\S]*?<\/phone_chat>/g, '').trim();
            }
            if (!text) return;

            // 先在 raw 文本上抓时间/场景（避免 cleanRules 吃掉括号导致提取失败）
            let meta = parseFloorMeta(text);
            if (meta) parsedCount++;
            // 部分匹配（只有时间）：地点/天气/心情从 lastMeta 继承一下，但**时间用本楼的新时间**
            if (meta && meta._partial && lastMeta) {
                meta = { ...meta, weekday: lastMeta.weekday || '', location: lastMeta.location || '', weather: lastMeta.weather || '', mood: lastMeta.mood || '' };
            }
            if (!meta && lastMeta) meta = { ...lastMeta, inherited: true };
            if (meta && !meta.inherited) lastMeta = meta;

            const cleaned = this.applyCleanRules(text, depth);
            memoryLines.push(`${name}：${cleaned}`);
            floors.push({
                role: m.is_user ? 'user' : 'char',
                name,
                content: cleaned,
                ...(meta || {})
            });
        });
        console.log(`[TavernSync] 拉取 ${validMsgs.length} 条，结构化解析命中 ${parsedCount} 条时间括号，生成 floors=${floors.length}`);
        if (floors.length > 0) {
            const withTime = floors.filter(f => f.storyTime).length;
            console.log(`[TavernSync] floors 中带 storyTime 的: ${withTime}/${floors.length}；首条样本:`, floors[0]);
        }
        if (parsedCount === 0 && validMsgs.length > 0) {
            console.warn('[TavernSync] ⚠️ 未匹配到任何时间括号！楼层前缀示例:', (validMsgs[0].mes || '').slice(0, 120));
        }

        char.tavernMemory = {
            lastSync: Date.now(),
            stCharAvatar: binding.stCharAvatar,
            stChatFile: binding.stChatFile,
            messageCount: validMsgs.length,
            content: memoryLines.join('\n'),
            floors,
            hiddenCutoffStoryTime,
        };

        // 绑定的世界书条目跟着一起刷新（写到 char.tavernWorldMemory）
        try {
            const wbR = await this.refreshBoundWorldMemory(binding);
            if (wbR.refreshed) console.log(`[TavernSync] Bound world refreshed: ${wbR.entryCount} entries`);
        } catch (e) { console.warn('[TavernSync] Refresh bound world failed:', e.message); }

        await saveData();
        // 拉到新楼层后剧情时间可能推进了，检查 story 模式 reminder
        if (typeof window !== 'undefined' && typeof window.checkStoryRemindersForChar === 'function') {
            window.checkStoryRemindersForChar(char);
        }
        return { imported: validMsgs.length };
    },

    // 推送到酒馆（增量推送 + 删除同步）
    // trackProgress: 是否更新 lastPushedMsgId。手动推送传 false，让自动/聊天页推送不受影响，方便反悔
    async pushToTavern(binding, pushCount, trackProgress = true) {
        const char = db.characters.find(c => c.id === binding.uwuCharId);
        if (!char) throw new Error('找不到角色');
        const stMsgs = await this.getSTChatMessages(binding.stCharAvatar, binding.stChatFile);

        // 状态栏剥离：当用户关闭"推送状态栏到酒馆"时，按角色状态栏正则把内联状态栏抹掉，
        // 并过滤掉专门的状态更新楼层（isStatusUpdate）
        const includeStatusBar = this.getConfig().pushIncludeStatusBar !== false;
        let statusBarRegex = null;
        if (!includeStatusBar && char.statusPanel && char.statusPanel.enabled && char.statusPanel.regexPattern) {
            let pattern = char.statusPanel.regexPattern;
            let flags = 'gs';
            const m = pattern.match(/^\/(.*?)\/([a-z]*)$/);
            if (m) { pattern = m[1]; flags = m[2] || 'gs'; if (!flags.includes('g')) flags += 'g'; if (!flags.includes('s')) flags += 's'; }
            try { statusBarRegex = new RegExp(pattern, flags); } catch (e) { console.warn('[TavernSync] 状态栏正则无效:', e.message); }
        }
        const stripStatusBar = (text) => {
            if (!statusBarRegex || !text) return text;
            return text.replace(statusBarRegex, '').trim();
        };

        // 推送前把 AI 输出里可能漏出来的 <thinking>...</thinking> 块整段抹掉
        // （isThinking=true 的独立消息已被下面 filter 排除；这里防的是和正文写在一条消息里的情况）
        const stripThinking = (text) => {
            if (!text) return text;
            return text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim();
        };

        // 当前 UwU 中所有非酒馆来源且有内容的消息
        // 排除：thinking 独立消息、上下文禁用、role=system（time perception / 时间跳跃这类只用来 UI 展示的"[system-display:...]"）
        // 关闭状态栏推送时也剔除 isStatusUpdate
        const allUwuMsgs = char.history.filter(m =>
            !m.fromTavern
            && m.content?.trim()
            && !m.isThinking
            && !m.isContextDisabled
            && m.role !== 'system'
            && (includeStatusBar || !m.isStatusUpdate)
        );
        // 构建 ID 集合，用于检测已删除的消息
        const uwuMsgIDs = new Set(allUwuMsgs.map(m => m.id));

        const all = Array.isArray(stMsgs) ? [...stMsgs] : [];

        // === 删除同步：重建已有的 from_uwu 消息，移除已删除的行 ===
        let hadDeletions = false;
        const deletionOps = []; // 记录每次变更，供 ST 端无感注入
        for (let i = 0; i < all.length; i++) {
            const stMsg = all[i];
            if (!stMsg?.extra?.from_uwu || !Array.isArray(stMsg.extra.uwu_msg_ids)) continue;
            const originalIds = [...stMsg.extra.uwu_msg_ids]; // 捕获原始 ID，用于 ST 端定位
            const survivingIds = stMsg.extra.uwu_msg_ids.filter(id => uwuMsgIDs.has(id));
            if (survivingIds.length === stMsg.extra.uwu_msg_ids.length) continue; // 无变化
            hadDeletions = true;
            if (survivingIds.length === 0) {
                if (stMsg.extra.uwu_created) {
                    // 这条消息完全由 uwu 创建（新楼层模式），可以安全删除
                    deletionOps.push({ action: 'remove', originalUwuMsgIds: originalIds });
                    all.splice(i, 1); i--; continue;
                } else {
                    // 这条消息是合并到已有楼层的，只清除 uwu 追加的内容，保留原始消息
                    stMsg.mes = (stMsg.mes || '').replace(/<phone_chat>[\s\S]*?<\/phone_chat>/g, '').trim();
                    // clearUwuFlags=true 通知 ST 端清除 from_uwu 标记，使该条消息不再被追踪
                    deletionOps.push({ action: 'update', originalUwuMsgIds: originalIds, mes: stMsg.mes, clearUwuFlags: true });
                    delete stMsg.extra.from_uwu;
                    delete stMsg.extra.uwu_msg_ids;
                    delete stMsg.extra.uwu_push_time;
                    continue;
                }
            }
            // 用幸存消息重建内容
            const survivingMsgs = survivingIds.map(id => allUwuMsgs.find(m => m.id === id)).filter(Boolean);
            const lines = survivingMsgs.map(m => this.applyCleanRules(stripThinking(stripStatusBar(m.content)), null));
            if (stMsg.extra.uwu_created) {
                // 纯 uwu 楼层：整体重建
                stMsg.mes = `<phone_chat>\n${lines.join('\n')}\n</phone_chat>`;
            } else {
                // 合并楼层：替换 phone_chat 部分，保留原始内容
                const phoneChat = `<phone_chat>\n${lines.join('\n')}\n</phone_chat>`;
                if (stMsg.mes.includes('<phone_chat>')) {
                    stMsg.mes = stMsg.mes.replace(/<phone_chat>[\s\S]*?<\/phone_chat>/g, phoneChat);
                }
            }
            // newUwuMsgIds 传给 ST 端，让注入 JS 同步更新内存中的 uwu_msg_ids，使下次删除仍可命中
            deletionOps.push({ action: 'update', originalUwuMsgIds: originalIds, mes: stMsg.mes, newUwuMsgIds: survivingIds });
            stMsg.extra.uwu_msg_ids = survivingIds;
        }

        // === 增量推送：找出上次推送之后的新消息 ===
        // 手动推送（pushCount 明确传入）时，直接取最后 N 条，忽略增量追踪
        // pushCount === 0 表示仅同步删除，不推送新消息
        let newMsgs;
        if (pushCount === 0) {
            newMsgs = [];
        } else if (pushCount) {
            newMsgs = allUwuMsgs.slice(-pushCount);
        } else if (binding.lastPushedMsgId) {
            const lastIdx = allUwuMsgs.findIndex(m => m.id === binding.lastPushedMsgId);
            if (lastIdx >= 0) {
                newMsgs = allUwuMsgs.slice(lastIdx + 1);
            } else {
                const count = this.getConfig().maxInjectMessages || 50;
                newMsgs = allUwuMsgs.slice(-count);
            }
        } else {
            const count = this.getConfig().maxInjectMessages || 50;
            newMsgs = allUwuMsgs.slice(-count);
        }

        let newMsg = null;
        let pushLines = [];
        if (newMsgs.length > 0) {
            pushLines = newMsgs.map(m => this.applyCleanRules(stripThinking(stripStatusBar(m.content)), null)).filter(l => l && l.trim());
            // 如果新消息经过状态栏剥离后全部为空，则视为无新消息（deletionOps 仍会处理）
            if (pushLines.length === 0) { newMsgs = []; }
        }
        if (newMsgs.length > 0) {
            const lines = pushLines;
            const mergedContent = `<phone_chat>\n${lines.join('\n')}\n</phone_chat>`;
            const pushMode = this.getConfig().pushMode || 'new';
            const lastMsg = all.length > 0 ? all[all.length - 1] : null;
            const lastIsUwu = lastMsg?.extra?.from_uwu;

            // 决定是否合并到已有楼层：
            // 1. 最后一楼是 from_uwu 且同侧（都是 user 侧）→ 合并（用户只是切了酒馆又回来）
            //    若是旧数据里的 AI 侧 from_uwu，不合并，新开 user 楼层保持干净
            // 2. 追加模式 → 合并到最后一楼（不管是谁的），配合正则隐藏实现视觉无新楼
            const lastIsUserSide = lastMsg?.is_user === true;
            if ((lastIsUwu && lastIsUserSide) || (pushMode === 'append' && lastMsg)) {
                const target = lastMsg;
                const existingContent = target.mes || '';
                const closingTag = '</phone_chat>';
                if (existingContent.includes(closingTag)) {
                    target.mes = existingContent.replace(closingTag, lines.join('\n') + '\n' + closingTag);
                } else {
                    target.mes = existingContent + '\n' + mergedContent;
                }
                if (!target.extra) target.extra = {};
                target.extra.from_uwu = true;
                target.extra.uwu_msg_ids = [...(target.extra.uwu_msg_ids || []), ...newMsgs.map(m => m.id)];
                target.extra.uwu_push_time = Date.now();
                // 合并模式：传递完整的更新后消息，标记 __mergeMode 供前端无感替换
                newMsg = Object.assign({}, target, { __mergeMode: true, avatar: binding.stCharAvatar });
            } else {
                // 新楼层模式（默认）：推送为 user 侧消息，方便用正则只剥离 AI 输出的 phone_chat
                const stCharName = (binding.stCharAvatar || '').replace(/\.png$/i, '');
                const savedMsg = {
                    name: char.myName || 'User',
                    is_user: true, is_system: false,
                    send_date: new Date().toISOString(),
                    mes: mergedContent,
                    // st_char_name 让原生注入脚本能把 user 侧消息路由到绑定的酒馆角色（否则按 name/avatar 匹配会失败）
                    extra: { from_uwu: true, uwu_created: true, uwu_push_time: Date.now(), uwu_msg_ids: newMsgs.map(m => m.id), st_char_name: stCharName },
                };
                all.push(savedMsg);
                // 注入载荷额外附带 avatar，命中 Swift 匹配器的 cur.avatar === msg.avatar 分支
                newMsg = Object.assign({}, savedMsg, { avatar: binding.stCharAvatar });
            }
        }

        // 有新消息或有删除才保存
        if (newMsgs.length > 0 || hadDeletions) {
            await this.apiCall('/api/chats/save', { avatar_url: binding.stCharAvatar, file_name: binding.stChatFile, chat: all });
        }

        // 更新推送追踪（只有真正推送了新消息才更新基准点）
        // 删除同步不能改变 lastPushedMsgId，否则下次推送会跳过中间的 user 消息
        // trackProgress=false 时（手动推送）也不改基准点，留出反悔余地
        if (trackProgress && newMsgs.length > 0 && allUwuMsgs.length > 0) {
            binding.lastPushedMsgId = allUwuMsgs[allUwuMsgs.length - 1].id;
            await this.saveConfig(this.getConfig());
        }

        return { pushed: newMsgs.length, deleted: hadDeletions, message: newMsg, deletionOps };
    },

    // 把 lastPushedMsgId 之后的所有未推送消息浓缩成一条总结（用专用总结 API，没配就 fallback 主 API）
    // 通用总结：根据 mode 决定切片
    //   mode='unpushed' (默认)：自上次推送之后的所有消息（半自动 / 聊天页用）
    //   mode='lastN' + count：取最近 N 条（手动 / 绑定卡用，不限是否已推送）
    async summarizeUnpushedSlice(binding, opts) {
        const options = opts || {};
        const mode = options.mode || 'unpushed';
        const char = db.characters.find(c => c.id === binding.uwuCharId);
        if (!char) throw new Error('找不到角色');

        const allUwuMsgs = char.history.filter(m => !m.fromTavern && m.content?.trim() && !m.isThinking && !m.isContextDisabled);
        let unpushed;
        if (mode === 'lastN') {
            const n = Math.max(1, Math.min(options.count || 1, allUwuMsgs.length));
            unpushed = allUwuMsgs.slice(-n);
        } else if (binding.lastPushedMsgId) {
            const idx = allUwuMsgs.findIndex(m => m.id === binding.lastPushedMsgId);
            unpushed = idx >= 0 ? allUwuMsgs.slice(idx + 1) : allUwuMsgs;
        } else {
            unpushed = allUwuMsgs;
        }
        if (unpushed.length === 0) throw new Error('没有可总结的消息');

        const apiCfg = (db.summaryApiSettings && db.summaryApiSettings.url && db.summaryApiSettings.key && db.summaryApiSettings.model)
            ? db.summaryApiSettings : db.apiSettings;
        if (!apiCfg || !apiCfg.url || !apiCfg.key || !apiCfg.model) throw new Error('请先配置总结 API 或主 API');
        let url = apiCfg.url; if (url.endsWith('/')) url = url.slice(0, -1);

        const charName = char.realName || char.name || '对方';
        const myName = char.myName || '我';
        const transcript = unpushed.map(m => {
            const who = m.role === 'user' ? myName : charName;
            const text = (m.content || '').replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim();
            return `${who}：${text}`;
        }).filter(s => s.split('：')[1]).join('\n');

        const prompt = `请把以下手机聊天记录浓缩成一段简短的第三人称客观总结（约 100-250 字）：
- 保留关键事件、决定、情绪转折、新出现的设定
- 客观平实，不要价值升华或情绪渲染
- 不要包含"总结如下"之类的开场白，直接输出总结内容

【聊天双方】${myName}（用户）与 ${charName}
【聊天记录】
${transcript}`;

        const messages = [{ role: 'user', content: prompt }];
        let body = { model: apiCfg.model, messages, stream: false, temperature: 0.5 };
        let endpoint, headers;
        if (apiCfg.provider === 'gemini') {
            body = { contents: [{ role: 'user', parts: [{ text: prompt }] }] };
            endpoint = `${url}/v1beta/models/${apiCfg.model}:generateContent?key=${apiCfg.key}`;
            headers = { 'Content-Type': 'application/json' };
        } else {
            endpoint = `${url}/v1/chat/completions`;
            headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiCfg.key}` };
        }

        const resp = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
        if (!resp.ok) throw new Error(`总结 API 失败: ${resp.status}`);
        const data = await resp.json();
        let text = (apiCfg.provider === 'gemini')
            ? (data.candidates?.[0]?.content?.parts?.[0]?.text || '')
            : (data.choices?.[0]?.message?.content || '');
        text = text.replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim();
        if (!text) throw new Error('总结内容为空');

        return {
            text,
            coveredMsgIds: unpushed.map(m => m.id),
            coveredCount: unpushed.length,
            lastMsgId: unpushed[unpushed.length - 1].id,
        };
    },

    // 推送一条小总结到酒馆，并把 lastPushedMsgId 推进到被覆盖的最后一条
    async pushSummaryToTavern(binding, summaryText, lastCoveredMsgId, coveredMsgIds) {
        const char = db.characters.find(c => c.id === binding.uwuCharId);
        if (!char) throw new Error('找不到角色');
        const text = (summaryText || '').trim();
        if (!text) throw new Error('总结内容为空');

        const stMsgs = await this.getSTChatMessages(binding.stCharAvatar, binding.stChatFile);
        const all = Array.isArray(stMsgs) ? [...stMsgs] : [];

        const myName = char.myName || '我';
        const stCharName = (binding.stCharAvatar || '').replace(/\.png$/i, '');
        const mergedContent = `<phone_chat>\n[小总结：${text}]\n</phone_chat>`;

        const savedMsg = {
            name: myName,
            is_user: true, is_system: false,
            send_date: new Date().toISOString(),
            mes: mergedContent,
            extra: { from_uwu: true, uwu_created: true, uwu_summary: true, uwu_push_time: Date.now(), uwu_msg_ids: coveredMsgIds || [], st_char_name: stCharName },
        };
        all.push(savedMsg);
        await this.apiCall('/api/chats/save', { avatar_url: binding.stCharAvatar, file_name: binding.stChatFile, chat: all });

        // 总结代表了那段消息，推进追踪点（与原始批量推送行为一致）
        if (lastCoveredMsgId) {
            binding.lastPushedMsgId = lastCoveredMsgId;
            await this.saveConfig(this.getConfig());
        }

        const injectMsg = Object.assign({}, savedMsg, { avatar: binding.stCharAvatar });
        try { window.webkit?.messageHandlers?.tavernPushDone?.postMessage({ message: injectMsg }); } catch {}
        return { pushed: 1, message: injectMsg };
    },

    // 推送通话记录到酒馆（独立于 char.history 的增量追踪，不影响 lastPushedMsgId）
    async pushCallRecordToTavern(binding, callRecord) {
        const char = db.characters.find(c => c.id === binding.uwuCharId);
        if (!char) throw new Error('找不到角色');
        if (!callRecord || !Array.isArray(callRecord.context) || callRecord.context.length === 0) {
            throw new Error('通话记录为空');
        }

        const stMsgs = await this.getSTChatMessages(binding.stCharAvatar, binding.stChatFile);
        const all = Array.isArray(stMsgs) ? [...stMsgs] : [];

        const charName = char.realName || char.name || '对方';
        const myName = char.myName || '我';
        const typeLabel = callRecord.type === 'video' ? '视频通话' : '语音通话';

        // 头部时间行：优先用通话记录里锁定的 timeStr（story 模式下是 storyNow + duration 算出的剧情结束时间）；
        // 否则按旧逻辑兜底。story 模式找不到剧情时间就不写时间，避免真实时间污染
        const isStoryMode = (char.timeMode || 'real') === 'story';
        let timeStr = '';
        if (callRecord.timeStr) {
            timeStr = callRecord.timeStr;
        } else if (isStoryMode) {
            const storyNow = (typeof window !== 'undefined' && typeof window.getCharStoryNow === 'function') ? window.getCharStoryNow(char) : null;
            if (storyNow && storyNow.ms) {
                const endMs = storyNow.ms + (Number(callRecord.duration) || 0) * 1000;
                const d = new Date(endMs);
                timeStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
            }
        } else {
            const startDate = new Date(callRecord.startTime || Date.now());
            timeStr = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}-${String(startDate.getDate()).padStart(2, '0')} ${String(startDate.getHours()).padStart(2, '0')}:${String(startDate.getMinutes()).padStart(2, '0')}`;
        }
        const durationStr = (() => {
            const s = Number(callRecord.duration || 0);
            return `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;
        })();

        const headerParts = [typeLabel];
        if (timeStr) headerParts.push(timeStr);
        headerParts.push(`时长 ${durationStr}`);
        const lines = [`[${headerParts.join(' · ')}]`];
        callRecord.context.forEach(m => {
            const who = m.role === 'user' ? myName : charName;
            const kind = m.type === 'visual' ? '的画面' : '的声音';
            const raw = (m.content || '').trim();
            if (!raw) return;
            lines.push(`[${who}${kind}：${raw}]`);
        });
        if (callRecord.summary && callRecord.summary.trim()) {
            lines.push(`[通话总结：${callRecord.summary.trim()}]`);
        }

        const mergedContent = `<phone_call>\n${lines.join('\n')}\n</phone_call>`;
        const stCharName = (binding.stCharAvatar || '').replace(/\.png$/i, '');
        const savedMsg = {
            name: myName,
            is_user: true, is_system: false,
            send_date: new Date().toISOString(),
            mes: mergedContent,
            extra: { from_uwu: true, uwu_created: true, uwu_push_time: Date.now(), uwu_call_id: callRecord.id, st_char_name: stCharName },
        };
        all.push(savedMsg);
        await this.apiCall('/api/chats/save', { avatar_url: binding.stCharAvatar, file_name: binding.stChatFile, chat: all });

        const injectMsg = Object.assign({}, savedMsg, { avatar: binding.stCharAvatar });
        try { window.webkit?.messageHandlers?.tavernPushDone?.postMessage({ message: injectMsg }); } catch {}

        return { pushed: 1, lineCount: lines.length - 1, message: injectMsg };
    },

    // ========== 自动同步 ==========

    // 查找角色对应的绑定
    findBindingForChar(charId) {
        const cfg = this.getConfig();
        return cfg.bindings.find(b => b.uwuCharId === charId);
    },

    // 自动拉取（进入聊天时调用）
    async autoPullIfNeeded(charId) {
        const cfg = this.getConfig();
        if (!cfg.enabled || !cfg.autoPull) return;
        const binding = this.findBindingForChar(charId);
        if (!binding) return;
        try {
            const r = await this.pullFromTavern(binding);
            if (r.imported > 0) console.log(`[TavernSync] Auto-pull: ${r.imported} messages`);
        } catch (e) { console.warn('[TavernSync] Auto-pull failed:', e.message); }
    },

    // 仅同步删除（消息被删后立即调用，不推送新消息）
    async autoDeletionSyncIfNeeded(charId) {
        const cfg = this.getConfig();
        if (!cfg.enabled || !cfg.autoPush) return;
        const binding = this.findBindingForChar(charId);
        if (!binding) return;
        try {
            const r = await this.pushToTavern(binding, 0);
            if (r.deletionOps && r.deletionOps.length > 0) {
                console.log('[TavernSync] Deletion sync: injecting into ST');
                try { window.webkit?.messageHandlers?.tavernPushDone?.postMessage({ deletions: r.deletionOps }); } catch {}
            }
        } catch (e) { console.warn('[TavernSync] Deletion sync failed:', e.message); }
    },

    // 自动推送（AI 回复后调用）
    async autoPushIfNeeded(charId) {
        const cfg = this.getConfig();
        if (!cfg.enabled || !cfg.autoPush) return;
        const binding = this.findBindingForChar(charId);
        if (!binding) return;
        try {
            const r = await this.pushToTavern(binding);
            if (r.pushed > 0 || r.deleted) {
                console.log(`[TavernSync] Auto-push: ${r.pushed} new, deleted=${r.deleted}`);
                try {
                    var payload = r.message ? { message: r.message } : { reload: true };
                    window.webkit?.messageHandlers?.tavernPushDone?.postMessage(payload);
                } catch {}
            }
        } catch (e) { console.warn('[TavernSync] Auto-push failed:', e.message); }
    },

    // 页面可见时自动同步（从酒馆切回来时触发拉取 + 删除同步）
    _visibilityListenerAdded: false,
    setupVisibilitySync() {
        if (this._visibilityListenerAdded) return;
        this._visibilityListenerAdded = true;
        document.addEventListener('visibilitychange', () => {
            // 只在聊天界面时才运行同步，避免在主页触发意外操作
            // OVO 通过 active class 控制屏幕显示，不是 display:none
            const chatScreen = document.getElementById('chat-room-screen');
            if (!chatScreen || !chatScreen.classList.contains('active')) return;

            const cfg = this.getConfig();
            if (!cfg.enabled) return;
            const charId = typeof currentChatId !== 'undefined' ? currentChatId : null;
            if (!charId) return;
            const binding = this.findBindingForChar(charId);
            if (!binding) return;

            if (document.hidden) {
                // 用户正在离开 OVO（切换到酒馆）→ 立即同步删除，静默写入不刷新 ST
                if (cfg.autoPush) {
                    this.pushToTavern(binding, 0).then(r => {
                        if (r.deleted) console.log('[TavernSync] Leave-sync: delete synced to ST silently');
                    }).catch(() => {});
                }
            } else {
                // 用户回到 OVO → 自动拉取最新记忆
                if (cfg.autoPull) {
                    this.pullFromTavern(binding).then(r => {
                        if (r.imported > 0) console.log(`[TavernSync] Visibility pull: ${r.imported} messages`);
                    }).catch(() => {});
                }
                // 回来时也做一次删除同步（兜底，防止离开时未能同步的情况）
                if (cfg.autoPush) {
                    this.pushToTavern(binding, 0).then(r => {
                        if (r.deleted) {
                            console.log('[TavernSync] Return-sync: delete synced to ST');
                            try { window.webkit?.messageHandlers?.tavernPushDone?.postMessage({ reload: true }); } catch {}
                        }
                    }).catch(() => {});
                }
            }
        });
    },

    // 导入角色设定 + 用户人设
    async importCharSettings(binding) {
        const stChar = await this.getSTCharacter(binding.stCharAvatar);
        const d = stChar.data || stChar;
        const parts = [];
        if (d.description) parts.push(d.description);
        if (d.personality) parts.push(`性格：${d.personality}`);
        if (d.scenario) parts.push(`场景：${d.scenario}`);
        const charPersona = parts.join('\n\n');

        let userPersonas = [];
        let activePersona = '';
        try {
            const settings = await this.getSTSettings();
            const pu = settings.power_user || {};
            const personas = pu.personas || {};
            const descs = pu.persona_descriptions || {};
            activePersona = pu.persona_description || '';
            for (const [avatar, name] of Object.entries(personas)) {
                const descObj = descs[avatar] || {};
                userPersonas.push({ avatar, name, description: descObj.description || '' });
            }
        } catch (e) { console.warn('[TavernSync] Failed to load user personas:', e); }

        return { charPersona, charName: d.name, userPersonas, activePersona, postHistory: d.post_history_instructions || '' };
    },

    // 获取角色世界书（优先关联世界书，没有则用内嵌）+ 聊天世界书
    async getCharAndChatWorldBooks(binding) {
        const stChar = await this.getSTCharacter(binding.stCharAvatar);
        const d = stChar.data || stChar;
        const result = { charWorld: null, chatWorld: null };

        // 角色世界书：优先读取关联世界书，没有才读内嵌
        const worldName = d.extensions?.world;
        if (worldName) {
            try {
                const wi = await this.getSTWorldInfo(worldName);
                const entries = Object.values(wi.entries || {}).map(e => ({
                    uid: e.uid, comment: e.comment || '未命名', content: e.content || '', key: e.key || '',
                    order: e.order ?? e.uid ?? 0, position: e.position, disabled: !!e.disable, constant: !!e.constant,
                }));
                entries.sort((a, b) => a.order - b.order);
                result.charWorld = { name: worldName, entries };
            } catch (e) { console.warn('[TavernSync] Failed to load char world:', e); }
        } else if (d.character_book?.entries) {
            const entries = Object.values(d.character_book.entries).map(e => ({
                uid: e.uid, comment: e.comment || '未命名', content: e.content || '', key: e.key || '',
                order: e.order ?? e.uid ?? 0, position: e.position, disabled: !!e.disable, constant: !!e.constant,
            }));
            entries.sort((a, b) => a.order - b.order);
            result.charWorld = { name: '角色内嵌世界书', entries };
        }

        // 聊天世界书
        if (binding.stChatFile) {
            try {
                const msgs = await this.getSTChatMessages(binding.stCharAvatar, binding.stChatFile);
                if (msgs?.[0]?.chat_metadata?.world_info) {
                    const chatWbName = msgs[0].chat_metadata.world_info;
                    const wi = await this.getSTWorldInfo(chatWbName);
                    const entries = Object.values(wi.entries || {}).map(e => ({
                        uid: e.uid, comment: e.comment || '未命名', content: e.content || '', key: e.key || '',
                        order: e.order ?? e.uid ?? 0, position: e.position, disabled: !!e.disable, constant: !!e.constant,
                    }));
                    entries.sort((a, b) => a.order - b.order);
                    result.chatWorld = { name: chatWbName, entries };
                }
            } catch (e) { console.warn('[TavernSync] Failed to load chat world:', e); }
        }

        return result;
    },

    // 按 binding.boundWorldBook 重新拉取条目并刷新 char.tavernWorldMemory
    // 自动同步酒馆时调用，让总结世界书条目变化能跟着同步进来
    async refreshBoundWorldMemory(binding) {
        const bound = binding.boundWorldBook;
        if (!bound || !Array.isArray(bound.entryUids) || !bound.entryUids.length) return { refreshed: false };
        const char = db.characters.find(c => c.id === binding.uwuCharId);
        if (!char) return { refreshed: false };

        const worldBooks = await this.getCharAndChatWorldBooks(binding);
        const src = bound.sourceType === 'chat' ? worldBooks.chatWorld : worldBooks.charWorld;
        if (!src) return { refreshed: false };

        const uidSet = new Set(bound.entryUids);
        const matched = src.entries.filter(e => uidSet.has(e.uid));
        if (!matched.length) {
            // 全部条目都不在了，清空 memory，保留 binding 让用户感知
            char.tavernWorldMemory = { lastSync: Date.now(), entryCount: 0, source: src.name, content: '', bound: true };
            return { refreshed: true, entryCount: 0 };
        }
        matched.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        const memoryText = matched.map(e => { let t = ''; if (e.comment) t += `[${e.comment}]\n`; t += e.content; return t; }).join('\n\n---\n\n');
        char.tavernWorldMemory = { lastSync: Date.now(), entryCount: matched.length, source: src.name, content: memoryText, bound: true };
        return { refreshed: true, entryCount: matched.length };
    },
};

// ========== UI 样式常量 ==========
const TS = {
    card: 'background:var(--received-bg, rgba(255,255,255,0.08)); border-radius:14px; padding:16px; margin-bottom:12px;',
    label: 'font-size:13px; color:#999; display:block; margin-bottom:4px;',
    input: 'width:100%; padding:10px; border-radius:10px; border:1px solid rgba(255,255,255,0.15); background:transparent; color:inherit; font-size:14px; box-sizing:border-box;',
    btnP: 'padding:10px; border-radius:10px; border:none; background:linear-gradient(135deg, #667eea, #764ba2); color:white; font-size:14px; font-weight:500; cursor:pointer;',
    btnG: 'padding:8px; border-radius:8px; border:none; background:rgba(76,175,80,0.15); color:#4CAF50; font-size:13px; font-weight:500; cursor:pointer;',
    btnB: 'padding:8px; border-radius:8px; border:none; background:rgba(33,150,243,0.15); color:#2196F3; font-size:13px; font-weight:500; cursor:pointer;',
    btnO: 'padding:8px; border-radius:8px; border:none; background:rgba(255,152,0,0.15); color:#FF9800; font-size:13px; font-weight:500; cursor:pointer;',
    btnD: 'background:none; border:none; color:#f44; font-size:18px; cursor:pointer; padding:4px 8px;',
    title: 'font-size:15px; font-weight:600;',
};

// ========== 主界面 ==========
function setupTavernSyncScreen() {
    const screen = document.getElementById('tavern-sync-screen');
    if (!screen) return;
    const mainEl = screen.querySelector('main.content') || screen.querySelector('main');
    if (!mainEl) return;
    const config = TavernSync.getConfig();

    mainEl.innerHTML = `
        <div style="padding:4px 0;">
            <div style="${TS.card}">
                <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;">
                    <span style="${TS.title}">SillyTavern 连接</span>
                    <span id="ts-status" style="font-size:12px; color:#999;">检测中...</span>
                </div>
                <div id="ts-login-area"></div>
            </div>
            <div id="ts-bindings-area" style="display:none; margin-top:12px;">
                <div style="${TS.card}">
                    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;">
                        <span style="${TS.title}">角色绑定</span>
                        <button id="ts-add-btn" style="padding:6px 14px; border-radius:8px; border:none; background:var(--sent-bg, rgba(255,204,204,0.9)); color:var(--sent-text, #a56767); font-size:13px; cursor:pointer;">+ 添加</button>
                    </div>
                    <div id="ts-bindings-list"></div>
                </div>
            </div>
            <div id="ts-rules-area" style="display:none; margin-top:12px;">
                <div style="${TS.card}">
                    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;">
                        <span style="${TS.title}">正则清洗规则</span>
                        <button id="ts-add-rule-btn" style="padding:4px 10px; border-radius:6px; border:none; background:rgba(255,255,255,0.1); color:inherit; font-size:12px; cursor:pointer;">+ 添加规则</button>
                    </div>
                    <div style="font-size:12px; color:#888; margin-bottom:10px;">同步时按顺序处理消息。提取=只保留匹配内容，排除=删除匹配内容。</div>
                    <div id="ts-rules-list"></div>
                </div>
            </div>
            <div id="ts-settings-area" style="display:none; margin-top:12px;">
                <div style="${TS.card}">
                    <span style="${TS.title}">同步设置</span>
                    <div style="display:flex; align-items:center; gap:10px; margin-top:12px;">
                        <span style="font-size:14px;">最多注入消息数</span>
                        <input type="number" id="ts-max" value="${config.maxInjectMessages || 50}" min="1" max="999"
                            style="width:70px; padding:6px 8px; border-radius:8px; border:1px solid rgba(255,255,255,0.2); background:transparent; color:inherit; font-size:14px; text-align:center;">
                    </div>
                    <div style="display:flex; align-items:center; gap:10px; margin-top:12px;">
                        <span style="font-size:14px;">世界书注入位置</span>
                        <select id="ts-wb-pos" style="padding:6px 8px; border-radius:8px; border:1px solid rgba(255,255,255,0.2); background:transparent; color:inherit; font-size:14px;">
                            <option value="before_chat" ${config.worldBookPosition === 'before_chat' ? 'selected' : ''}>聊天记忆之前</option>
                            <option value="after_chat" ${config.worldBookPosition === 'after_chat' ? 'selected' : ''}>聊天记忆之后</option>
                        </select>
                    </div>
                    <label style="display:flex; align-items:center; gap:10px; margin-top:12px; font-size:14px; cursor:pointer;">
                        <input type="checkbox" id="ts-push-status-bar" ${config.pushIncludeStatusBar !== false ? 'checked' : ''}>
                        <div>
                            <div>推送状态栏到酒馆</div>
                            <div style="font-size:11px; color:#888;">关闭后，推送到酒馆的小手机消息将按角色状态栏正则剥离内联状态栏，并过滤专用状态更新楼层</div>
                        </div>
                    </label>
                    <label style="display:flex; align-items:center; gap:10px; margin-top:12px; font-size:14px; cursor:pointer;">
                        <input type="checkbox" id="ts-inject-user-floors" ${config.injectUserFloors !== false ? 'checked' : ''}>
                        <div>
                            <div>注入酒馆 user 楼层到 AI 上下文</div>
                            <div style="font-size:11px; color:#888;">关闭后，从酒馆拉取的剧情记忆只保留 AI / 角色 楼层，跳过 user 楼层。节省 token，适合"我已经知道我说过啥"的场景</div>
                        </div>
                    </label>
                    <label style="display:flex; align-items:center; gap:10px; margin-top:12px; font-size:14px; cursor:pointer;">
                        <input type="checkbox" id="ts-inject-journals" ${config.injectFavoritedJournals !== false ? 'checked' : ''}>
                        <div>
                            <div>注入收藏日记到 AI 上下文</div>
                            <div style="font-size:11px; color:#888;">关闭后，已收藏的日记不再作为"共同回忆"喂给 AI，但日记页仍可正常阅读。适合主要靠酒馆楼层维护剧情记忆的玩法</div>
                        </div>
                    </label>
                </div>
                <div style="${TS.card} margin-top:12px;">
                    <span style="${TS.title}">自动同步</span>
                    <label style="display:flex; align-items:center; gap:10px; margin-top:12px; font-size:14px; cursor:pointer;">
                        <input type="checkbox" id="ts-auto-pull" ${config.autoPull ? 'checked' : ''}>
                        <div>
                            <div>进入聊天时自动拉取记忆</div>
                            <div style="font-size:11px; color:#888;">打开已绑定角色的聊天时，自动从酒馆同步最新记忆</div>
                        </div>
                    </label>
                    <label style="display:flex; align-items:center; gap:10px; margin-top:12px; font-size:14px; cursor:pointer;">
                        <input type="checkbox" id="ts-auto-push" ${config.autoPush ? 'checked' : ''}>
                        <div>
                            <div>AI 回复后自动推送到酒馆</div>
                            <div style="font-size:11px; color:#888;">自动追踪并只推送新消息，切换到酒馆时无感注入</div>
                        </div>
                    </label>
                    <div style="display:flex; align-items:center; gap:10px; margin-top:12px;">
                        <span style="font-size:14px;">推送楼层模式</span>
                        <select id="ts-push-mode" style="padding:6px 8px; border-radius:8px; border:1px solid rgba(255,255,255,0.2); background:transparent; color:inherit; font-size:14px;">
                            <option value="new" ${(config.pushMode || 'new') === 'new' ? 'selected' : ''}>新开楼层</option>
                            <option value="append" ${config.pushMode === 'append' ? 'selected' : ''}>合并到最后一楼</option>
                        </select>
                    </div>
                    <div style="font-size:11px; color:#888; margin-top:4px;">新开楼层：每次推送创建新消息；合并末尾：追加到最后一楼末尾（配合正则隐藏）。注：若最后一楼已是小手机消息，无论模式都会自动合并</div>
                </div>
                <div style="${TS.card} margin-top:12px;">
                    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:6px;">
                        <span style="${TS.title}">剧情时间正则</span>
                        <button id="ts-time-reset" style="padding:4px 10px; border-radius:6px; border:none; background:rgba(255,255,255,0.1); color:inherit; font-size:12px; cursor:pointer;">恢复默认</button>
                    </div>
                    <div style="font-size:12px; color:#888; margin-bottom:8px; line-height:1.55;">
                        从酒馆楼层文本里提取剧情时间和场景信息。命名捕获组：
                        <span style="color:#ffb380;">year / month / day / hour / minute</span> 必填，
                        <span style="color:#aab;">weekday / location / weather / mood</span> 可选（缺失会从上一楼继承）。
                    </div>
                    <textarea id="ts-time-regex" rows="4" spellcheck="false"
                        style="width:100%; box-sizing:border-box; padding:8px 10px; border-radius:8px; border:1px solid rgba(255,255,255,0.2); background:rgba(0,0,0,0.2); color:inherit; font-size:12px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; resize:vertical;">${(config.timeRegex || '').replace(/</g, '&lt;')}</textarea>
                    <div style="display:flex; gap:8px; margin-top:8px;">
                        <input id="ts-time-test-input" placeholder="粘贴一段酒馆楼层文本测试"
                            style="flex:1; padding:8px 10px; border-radius:8px; border:1px solid rgba(255,255,255,0.2); background:transparent; color:inherit; font-size:12px;">
                        <button id="ts-time-test-btn" style="padding:6px 14px; border-radius:8px; border:none; background:rgba(255,255,255,0.12); color:inherit; font-size:12px; cursor:pointer; white-space:nowrap;">测试</button>
                    </div>
                    <div id="ts-time-test-result" style="margin-top:8px; font-size:12px; line-height:1.6; color:#aab; min-height:18px;"></div>
                </div>
            </div>
        </div>`;

    const statusEl = mainEl.querySelector('#ts-status');
    const loginArea = mainEl.querySelector('#ts-login-area');
    const bindingsArea = mainEl.querySelector('#ts-bindings-area');
    const rulesArea = mainEl.querySelector('#ts-rules-area');
    const settingsArea = mainEl.querySelector('#ts-settings-area');
    const bindingsList = mainEl.querySelector('#ts-bindings-list');
    const rulesList = mainEl.querySelector('#ts-rules-list');

    mainEl.querySelector('#ts-max').addEventListener('change', async (e) => { const cfg = TavernSync.getConfig(); cfg.maxInjectMessages = parseInt(e.target.value) || 50; await TavernSync.saveConfig(cfg); });
    mainEl.querySelector('#ts-wb-pos').addEventListener('change', async (e) => { const cfg = TavernSync.getConfig(); cfg.worldBookPosition = e.target.value; await TavernSync.saveConfig(cfg); });
    mainEl.querySelector('#ts-push-status-bar').addEventListener('change', async (e) => { const cfg = TavernSync.getConfig(); cfg.pushIncludeStatusBar = e.target.checked; await TavernSync.saveConfig(cfg); });
    mainEl.querySelector('#ts-inject-user-floors').addEventListener('change', async (e) => { const cfg = TavernSync.getConfig(); cfg.injectUserFloors = e.target.checked; await TavernSync.saveConfig(cfg); });
    mainEl.querySelector('#ts-inject-journals').addEventListener('change', async (e) => { const cfg = TavernSync.getConfig(); cfg.injectFavoritedJournals = e.target.checked; await TavernSync.saveConfig(cfg); });
    mainEl.querySelector('#ts-auto-pull').addEventListener('change', async (e) => { const cfg = TavernSync.getConfig(); cfg.autoPull = e.target.checked; await TavernSync.saveConfig(cfg); });
    mainEl.querySelector('#ts-auto-push').addEventListener('change', async (e) => {
        const cfg = TavernSync.getConfig(); cfg.autoPush = e.target.checked; await TavernSync.saveConfig(cfg);
    });
    mainEl.querySelector('#ts-push-mode').addEventListener('change', async (e) => {
        const cfg = TavernSync.getConfig(); cfg.pushMode = e.target.value; await TavernSync.saveConfig(cfg);
    });
    mainEl.querySelector('#ts-add-btn').addEventListener('click', () => showBindingEditor(() => renderBindings()));
    mainEl.querySelector('#ts-add-rule-btn').addEventListener('click', () => showRuleEditor(null, () => renderRules()));

    // 剧情时间正则
    const timeRegexEl = mainEl.querySelector('#ts-time-regex');
    const timeTestEl = mainEl.querySelector('#ts-time-test-input');
    const timeTestResultEl = mainEl.querySelector('#ts-time-test-result');
    const updateTimeRegexValidity = () => {
        const src = timeRegexEl.value.trim();
        if (!src) { timeRegexEl.style.borderColor = 'rgba(255,255,255,0.2)'; return; }
        try { new RegExp(src); timeRegexEl.style.borderColor = 'rgba(76,175,80,0.5)'; }
        catch { timeRegexEl.style.borderColor = 'rgba(244,67,54,0.6)'; }
    };
    timeRegexEl.addEventListener('input', updateTimeRegexValidity);
    timeRegexEl.addEventListener('change', async () => {
        const src = timeRegexEl.value.trim();
        const cfg = TavernSync.getConfig();
        try {
            if (src) new RegExp(src);
            cfg.timeRegex = src || TavernSync.DEFAULT_TIME_REGEX;
            await TavernSync.saveConfig(cfg);
        } catch (e) {
            alert('正则无效：' + e.message);
        }
    });
    mainEl.querySelector('#ts-time-reset').addEventListener('click', async () => {
        timeRegexEl.value = TavernSync.DEFAULT_TIME_REGEX;
        updateTimeRegexValidity();
        const cfg = TavernSync.getConfig();
        cfg.timeRegex = TavernSync.DEFAULT_TIME_REGEX;
        await TavernSync.saveConfig(cfg);
    });
    mainEl.querySelector('#ts-time-test-btn').addEventListener('click', () => {
        const src = timeRegexEl.value.trim() || TavernSync.DEFAULT_TIME_REGEX;
        const sample = timeTestEl.value;
        if (!sample) { timeTestResultEl.innerHTML = '<span style="color:#888;">请先粘贴一段文本</span>'; return; }
        let re;
        try { re = new RegExp(src); }
        catch (e) { timeTestResultEl.innerHTML = `<span style="color:#f55;">正则无效：${e.message}</span>`; return; }
        const m = sample.match(re);
        if (!m) { timeTestResultEl.innerHTML = '<span style="color:#f80;">没有匹配</span>'; return; }
        const g = m.groups || {};
        const must = ['year','month','day','hour','minute'];
        const missing = must.filter(k => !g[k]);
        if (missing.length) { timeTestResultEl.innerHTML = `<span style="color:#f80;">缺少必填命名组：${missing.join(', ')}</span>`; return; }
        const pad = x => String(x).padStart(2, '0');
        const time = `${g.year}-${pad(g.month)}-${pad(g.day)} ${pad(g.hour)}:${pad(g.minute)}`;
        const optional = ['weekday','location','weather','mood'].map(k => `<span style="color:#888;">${k}</span>=<span style="color:${g[k] ? '#9cf' : '#666'};">${g[k] ? g[k].trim() : '(空)'}</span>`).join('　');
        timeTestResultEl.innerHTML = `<span style="color:#4CAF50;">✓ 命中</span>　storyTime=<span style="color:#ffb380;">${time}</span><br>${optional}`;
    });
    updateTimeRegexValidity();

    // ===== 连接逻辑 =====
    function showConnected(charCount) {
        statusEl.innerHTML = `<span style="color:#4CAF50;">已连接（${charCount} 个角色）</span> <button id="ts-reconnect-btn" style="background:none; border:none; color:#999; font-size:14px; cursor:pointer; padding:2px 4px; vertical-align:middle;" title="重新连接">↻</button>`;
        statusEl.querySelector('#ts-reconnect-btn').addEventListener('click', checkAndLogin);
        loginArea.innerHTML = '';
        bindingsArea.style.display = 'block'; rulesArea.style.display = 'block'; settingsArea.style.display = 'block';
        renderBindings(); renderRules();
    }

    function showLoginUI(users) {
        statusEl.textContent = '需要登录'; statusEl.style.color = '#FF9800';
        // 即使未登录也显示已有绑定（只是不能操作）
        const cfg = TavernSync.getConfig();
        if (cfg.bindings.length) {
            bindingsArea.style.display = 'block';
            renderBindings();
        }
        if (users?.length) {
            loginArea.innerHTML = `<div style="font-size:13px; color:#999; margin-bottom:8px;">选择酒馆账户</div>
                ${users.map(u => `<button class="ts-user-btn" data-handle="${u.handle}" data-pwd="${u.password}"
                    style="display:flex; align-items:center; gap:10px; width:100%; padding:12px; border-radius:10px; border:none; background:rgba(255,255,255,0.06); color:inherit; font-size:14px; cursor:pointer; margin-bottom:8px; text-align:left;">
                    <span style="font-size:20px;">👤</span><span>${u.name || u.handle}</span>
                    ${u.password ? '<span style="font-size:11px; color:#999; margin-left:auto;">🔒</span>' : ''}</button>`).join('')}
                <div id="ts-password-area" style="display:none; margin-top:8px;">
                    <input type="password" id="ts-pwd-input" placeholder="输入密码" style="${TS.input} margin-bottom:8px;">
                    <button id="ts-pwd-submit" style="width:100%; ${TS.btnP}">登录</button></div>`;
            let selectedHandle = null;
            loginArea.querySelectorAll('.ts-user-btn').forEach(btn => {
                btn.addEventListener('click', () => { selectedHandle = btn.dataset.handle; if (btn.dataset.pwd === 'true') { loginArea.querySelector('#ts-password-area').style.display = 'block'; loginArea.querySelector('#ts-pwd-input').focus(); } else doLogin(selectedHandle, null); });
            });
            const pwdSubmit = loginArea.querySelector('#ts-pwd-submit'), pwdInput = loginArea.querySelector('#ts-pwd-input');
            if (pwdSubmit) { pwdSubmit.addEventListener('click', () => doLogin(selectedHandle, pwdInput.value)); pwdInput.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(selectedHandle, pwdInput.value); }); }
        } else {
            loginArea.innerHTML = `<button id="ts-retry-btn" style="width:100%; ${TS.btnP}">连接酒馆</button>`;
            loginArea.querySelector('#ts-retry-btn').addEventListener('click', checkAndLogin);
        }
    }

    async function doLogin(handle, password) {
        statusEl.textContent = '登录中...'; statusEl.style.color = '#999';
        try { await TavernSync.login(handle, password); const r = await TavernSync.testConnection();
            if (r.ok) {
                // 只更新 enabled 字段，不丢失其他数据
                const cfg = TavernSync.getConfig();
                cfg.enabled = true;
                await TavernSync.saveConfig(cfg);
                showConnected(r.count);
            } else { statusEl.textContent = `${r.error}`; statusEl.style.color = '#f44336'; }
        } catch (e) { statusEl.textContent = `${e.message}`; statusEl.style.color = '#f44336'; }
    }

    async function checkAndLogin() {
        statusEl.textContent = '连接中...'; statusEl.style.color = '#999'; loginArea.innerHTML = '';
        const r = await TavernSync.testConnection();
        if (r.ok) {
            const cfg = TavernSync.getConfig();
            cfg.enabled = true;
            await TavernSync.saveConfig(cfg);
            showConnected(r.count);
            return;
        }
        try { showLoginUI(await TavernSync.getUserList()); } catch { statusEl.textContent = '无法连接酒馆'; statusEl.style.color = '#f44336'; showLoginUI(null); }
    }

    // ===== 正则规则 =====
    function renderRules() {
        const cfg = TavernSync.getConfig();
        const rules = cfg.cleanRules || [];
        if (!rules.length) { rulesList.innerHTML = '<div style="text-align:center; color:#888; font-size:12px; padding:10px;">暂无规则，消息原样注入。</div>'; return; }
        rulesList.innerHTML = rules.map((r, i) => `
            <div style="display:flex; align-items:center; gap:8px; padding:8px; background:rgba(255,255,255,0.04); border-radius:8px; margin-bottom:6px;">
                <input type="checkbox" data-toggle="${i}" ${r.enabled ? 'checked' : ''} style="flex-shrink:0;">
                <div style="flex:1; min-width:0; cursor:pointer;" data-edit="${i}">
                    <div style="font-size:13px; font-weight:500;">${r.name || '未命名'}</div>
                    <div style="font-size:11px; color:#888; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${r.mode === 'extract' ? '提取' : '排除'} /${r.regex}/${r.minDepth != null || r.maxDepth != null ? ` 深度${r.minDepth ?? 0}~${r.maxDepth ?? '∞'}` : ''}</div>
                </div>
                <button data-delrule="${i}" style="${TS.btnD} font-size:14px;">✕</button>
            </div>`).join('');
        rulesList.querySelectorAll('[data-toggle]').forEach(cb => cb.addEventListener('change', async () => { const cfg = TavernSync.getConfig(); cfg.cleanRules[parseInt(cb.dataset.toggle)].enabled = cb.checked; await TavernSync.saveConfig(cfg); }));
        rulesList.querySelectorAll('[data-edit]').forEach(el => el.addEventListener('click', () => showRuleEditor(parseInt(el.dataset.edit), () => renderRules())));
        rulesList.querySelectorAll('[data-delrule]').forEach(btn => btn.addEventListener('click', async () => { const cfg = TavernSync.getConfig(); cfg.cleanRules.splice(parseInt(btn.dataset.delrule), 1); await TavernSync.saveConfig(cfg); renderRules(); }));
    }

    // ===== 绑定列表 =====
    function renderBindings() {
        const cfg = TavernSync.getConfig();
        if (!cfg.bindings?.length) { bindingsList.innerHTML = '<div style="text-align:center; color:#999; font-size:13px; padding:20px;">暂无绑定，点击上方「+ 添加」关联角色</div>'; return; }
        bindingsList.innerHTML = cfg.bindings.map((b, i) => {
            const char = db.characters.find(c => c.id === b.uwuCharId);
            const charName = char ? (char.remarkName || char.name) : '未知';
            const stName = b.stCharAvatar?.replace('.png', '') || '未知';
            const mem = char?.tavernMemory;
            const syncInfo = mem ? `已同步 ${mem.messageCount} 条 · ${new Date(mem.lastSync).toLocaleString('zh-CN', {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}` : '未同步';
            const wbMem = char?.tavernWorldMemory;
            const wbInfo = wbMem ? `${wbMem.entryCount} 条世界书` : '';
            return `<div style="${TS.card} padding:14px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                    <div><div style="font-size:14px; font-weight:600;">${charName} ↔ ${stName}</div>
                        <div style="font-size:11px; color:#888; margin-top:2px;">${syncInfo}${wbInfo ? ' · ' + wbInfo : ''}</div></div>
                    <button data-del="${i}" style="${TS.btnD}">✕</button></div>
                <div style="display:flex; gap:6px; flex-wrap:wrap;">
                    <button data-pull="${i}" style="flex:1; ${TS.btnG}">同步记忆</button>
                    <button data-push="${i}" style="flex:1; ${TS.btnB}">推送到酒馆</button></div>
                <div style="display:flex; gap:6px; flex-wrap:wrap; margin-top:6px;">
                    <button data-import-char="${i}" style="flex:1; ${TS.btnO}">导入设定</button>
                    <button data-import-wb="${i}" style="flex:1; ${TS.btnO}">世界书</button></div>
                <div style="display:flex; gap:6px; flex-wrap:wrap; margin-top:6px;">
                    <button data-preview="${i}" style="flex:1; padding:8px; border-radius:8px; border:none; background:rgba(156,39,176,0.15); color:#CE93D8; font-size:13px; font-weight:500; cursor:pointer;">提示词预览</button></div>
            </div>`;
        }).join('');

        const bindClick = (sel, handler) => bindingsList.querySelectorAll(sel).forEach(btn => btn.addEventListener('click', () => handler(btn)));

        bindClick('[data-del]', async (btn) => { const cfg = TavernSync.getConfig(); cfg.bindings.splice(parseInt(btn.dataset.del), 1); await TavernSync.saveConfig(cfg); renderBindings(); });

        bindClick('[data-pull]', async (btn) => {
            const cfg = TavernSync.getConfig(); const b = cfg.bindings[parseInt(btn.dataset.pull)];
            const orig = btn.textContent; btn.textContent = '同步中...'; btn.disabled = true;
            try { const r = await TavernSync.pullFromTavern(b); showToast(`同步了 ${r.imported} 条消息到记忆`); renderBindings(); }
            catch (e) { showToast(`${e.message}`); }
            btn.textContent = orig; btn.disabled = false;
        });

        bindClick('[data-push]', async (btn) => {
            const cfg = TavernSync.getConfig(); const b = cfg.bindings[parseInt(btn.dataset.push)];
            showPushOptionsModal(b, btn);
        });

        bindClick('[data-import-char]', async (btn) => {
            const cfg = TavernSync.getConfig(); const b = cfg.bindings[parseInt(btn.dataset.importChar)];
            btn.textContent = '加载中...'; btn.disabled = true;
            try { await showImportCharModal(b); } catch (e) { showToast(`${e.message}`); }
            btn.textContent = '导入设定'; btn.disabled = false;
        });

        bindClick('[data-import-wb]', async (btn) => {
            const cfg = TavernSync.getConfig(); const b = cfg.bindings[parseInt(btn.dataset.importWb)];
            btn.textContent = '加载中...'; btn.disabled = true;
            try { await showWorldBookModal(b); renderBindings(); } catch (e) { showToast(`${e.message}`); }
            btn.textContent = '世界书'; btn.disabled = false;
        });

        bindClick('[data-preview]', async (btn) => {
            const cfg = TavernSync.getConfig(); const b = cfg.bindings[parseInt(btn.dataset.preview)];
            showPromptPreview(b);
        });
    }

    checkAndLogin();
}

// ========== 聊天页推送弹窗（半自动 · 带追踪）==========
// 入口：聊天页右侧扩展面板的「推送酒馆」按钮
// 两种模式都会推进 lastPushedMsgId
//   - 原始：增量推送所有未推送消息
//   - 小总结：调用总结 API 把未推送消息浓缩成一段
async function showAutoPushModal(binding) {
    const char = db.characters.find(c => c.id === binding.uwuCharId);
    if (!char) { showToast('找不到角色'); return; }

    const allMsgs = char.history.filter(m => !m.fromTavern && m.content?.trim() && !m.isThinking && !m.isContextDisabled);
    let unpushed = allMsgs;
    if (binding.lastPushedMsgId) {
        const idx = allMsgs.findIndex(m => m.id === binding.lastPushedMsgId);
        if (idx >= 0) unpushed = allMsgs.slice(idx + 1);
    }
    const unpushedCount = unpushed.length;

    // 没有新消息 → 仍尝试同步删除
    if (unpushedCount === 0) {
        try {
            const r = await TavernSync.pushToTavern(binding, 0);
            if (r.deleted) {
                try { window.webkit?.messageHandlers?.tavernPushDone?.postMessage({ reload: true }); } catch {}
                showToast('已同步删除酒馆中的旧消息');
            } else {
                showToast('没有新消息需要推送');
            }
        } catch (e) { console.warn(e); showToast('没有新消息需要推送'); }
        return;
    }

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:9999; display:flex; align-items:center; justify-content:center; padding:20px;';
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-color, #1a1a2e); border-radius:16px; padding:20px; width:100%; max-width:400px; max-height:85vh; display:flex; flex-direction:column;';

    const previewLines = unpushed.slice(-10).map(m => m.content.length > 80 ? m.content.substring(0, 80) + '...' : m.content);
    const previewText = `&lt;phone_chat&gt;\n${previewLines.join('\n')}${unpushedCount > 10 ? '\n... 共 ' + unpushedCount + ' 条未推送' : ''}\n&lt;/phone_chat&gt;`;

    const tabBtn = (id, label, active) => `<button data-mode="${id}" class="auto-push-tab" style="flex:1; padding:8px; border-radius:8px; border:1px solid rgba(255,255,255,0.15); background:${active ? 'rgba(33,150,243,0.18)' : 'transparent'}; color:${active ? '#2196F3' : 'inherit'}; font-size:13px; cursor:pointer;">${label}</button>`;

    modal.innerHTML = `
        <h3 style="margin:0 0 4px; font-size:16px; font-weight:600;">推送到酒馆</h3>
        <div style="font-size:11px; color:#888; margin-bottom:12px;">半自动 · 推送后自动推进追踪基准点</div>
        <div style="display:flex; gap:6px; margin-bottom:12px;">
            ${tabBtn('raw', '原始消息', true)}
            ${tabBtn('summary', '小总结', false)}
        </div>

        <div id="auto-mode-raw" style="display:flex; flex-direction:column;">
            <div style="font-size:13px; margin-bottom:6px;">将推送 <b style="color:#2196F3;">${unpushedCount}</b> 条未推送消息</div>
            <div style="font-size:11px; color:#888; margin-bottom:6px;">用 &lt;phone_chat&gt; 标签包裹</div>
            <div style="font-size:12px; color:#ccc; background:rgba(255,255,255,0.04); border-radius:8px; padding:10px; margin-bottom:12px; max-height:200px; overflow-y:auto; white-space:pre-wrap; line-height:1.5; border-left:3px solid #2196F3;">${previewText}</div>
        </div>

        <div id="auto-mode-summary" style="display:none; flex-direction:column;">
            <div style="font-size:13px; margin-bottom:6px;">把<b>未推送的 ${unpushedCount} 条</b>消息浓缩成一段总结后推送（消耗 1 次总结 API）</div>
            <div style="font-size:11px; color:#888; margin-bottom:10px;">推送后会更新进度基准点，已总结的消息不会再次推送原文</div>
            <button id="auto-sum-gen" style="${TS.btnB} width:100%; margin-bottom:10px;">生成小总结</button>
            <textarea id="auto-sum-text" placeholder="生成后可在此编辑..." style="width:100%; box-sizing:border-box; min-height:140px; max-height:240px; padding:10px; border-radius:8px; border:1px solid rgba(255,255,255,0.15); background:rgba(255,255,255,0.04); color:inherit; font-size:13px; line-height:1.6; resize:vertical; margin-bottom:12px;"></textarea>
        </div>

        <div style="display:flex; gap:10px;">
            <button id="auto-cancel" style="flex:1; padding:10px; border-radius:10px; border:1px solid rgba(255,255,255,0.15); background:transparent; color:inherit; cursor:pointer;">取消</button>
            <button id="auto-confirm" style="flex:1; ${TS.btnP}">确认推送</button>
        </div>`;

    overlay.appendChild(modal); document.body.appendChild(overlay);

    let mode = 'raw';
    let summaryState = null;

    modal.querySelectorAll('.auto-push-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            mode = btn.dataset.mode;
            modal.querySelectorAll('.auto-push-tab').forEach(b => {
                const active = b.dataset.mode === mode;
                b.style.background = active ? 'rgba(33,150,243,0.18)' : 'transparent';
                b.style.color = active ? '#2196F3' : 'inherit';
            });
            modal.querySelector('#auto-mode-raw').style.display = mode === 'raw' ? 'flex' : 'none';
            modal.querySelector('#auto-mode-summary').style.display = mode === 'summary' ? 'flex' : 'none';
        });
    });

    const genBtn = modal.querySelector('#auto-sum-gen');
    const sumText = modal.querySelector('#auto-sum-text');
    genBtn.addEventListener('click', async () => {
        genBtn.disabled = true; genBtn.textContent = '生成中...';
        try {
            const r = await TavernSync.summarizeUnpushedSlice(binding);
            summaryState = { text: r.text, lastMsgId: r.lastMsgId, coveredMsgIds: r.coveredMsgIds };
            sumText.value = r.text;
            genBtn.textContent = `重新生成（已覆盖 ${r.coveredCount} 条）`;
        } catch (e) {
            showToast(`${e.message}`);
            genBtn.textContent = '生成小总结';
        } finally { genBtn.disabled = false; }
    });

    modal.querySelector('#auto-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

    modal.querySelector('#auto-confirm').addEventListener('click', async () => {
        const confirmBtn = modal.querySelector('#auto-confirm');
        confirmBtn.textContent = '推送中...'; confirmBtn.disabled = true;
        try {
            if (mode === 'summary') {
                const finalText = (sumText.value || '').trim();
                if (!finalText) { showToast('请先生成或填入总结文本'); confirmBtn.textContent = '确认推送'; confirmBtn.disabled = false; return; }
                if (!summaryState || !summaryState.lastMsgId) { showToast('请先点"生成小总结"'); confirmBtn.textContent = '确认推送'; confirmBtn.disabled = false; return; }
                const r = await TavernSync.pushSummaryToTavern(binding, finalText, summaryState.lastMsgId, summaryState.coveredMsgIds);
                if (r.pushed > 0) {
                    try { window.webkit?.messageHandlers?.tavernPushDone?.postMessage({ message: r.message }); } catch {}
                }
                showToast(`已推送小总结 · 覆盖 ${summaryState.coveredMsgIds?.length || 0} 条`);
                overlay.remove();
            } else {
                const r = await TavernSync.pushToTavern(binding); // 增量 + 追踪
                if (r.pushed > 0) {
                    try {
                        const payload = r.message ? { message: r.message } : { reload: true };
                        window.webkit?.messageHandlers?.tavernPushDone?.postMessage(payload);
                    } catch {}
                    showToast(`已推送 ${r.pushed} 条新消息到酒馆`);
                } else if (r.deleted) {
                    try { window.webkit?.messageHandlers?.tavernPushDone?.postMessage({ reload: true }); } catch {}
                    showToast('已同步删除酒馆中的旧消息');
                } else {
                    showToast('没有新消息需要推送');
                }
                overlay.remove();
            }
        } catch (e) {
            showToast(`${e.message}`);
            confirmBtn.textContent = '确认推送'; confirmBtn.disabled = false;
        }
    });
}

// ========== 推送选项弹窗（手动 · 不追踪）==========
// 入口：酒馆同步配置页绑定卡片的「推送到酒馆」按钮
// 不更新 lastPushedMsgId，给用户留反悔余地
//   - 原始：推送最近 N 条原始消息
//   - 小总结：用户手动输入一段总结文本，覆盖最近 N 条
async function showPushOptionsModal(binding, triggerBtn) {
    const char = db.characters.find(c => c.id === binding.uwuCharId);
    if (!char) { showToast('找不到角色'); return; }

    const allMsgs = char.history.filter(m => !m.fromTavern && m.content?.trim() && !m.isThinking && !m.isContextDisabled);
    if (!allMsgs.length) {
        // 没有新消息，但仍然尝试同步删除
        try {
            const r = await TavernSync.pushToTavern(binding, 0);
            if (r.deleted) {
                try { window.webkit?.messageHandlers?.tavernPushDone?.postMessage({ reload: true }); } catch {}
                showToast('已同步删除酒馆中的旧消息');
            } else {
                showToast('没有可推送的消息');
            }
        } catch (e) { console.warn(e); showToast('没有可推送的消息'); }
        return;
    }

    const totalCount = allMsgs.length;
    const defaultCount = Math.min(totalCount, TavernSync.getConfig().maxInjectMessages || 50);

    // 找出已推送/未推送的分界点（用于预览渲染时高亮）
    let pushedBoundaryIdx = -1; // allMsgs 中 lastPushedMsgId 的索引；之后（不含）都是未推送
    if (binding.lastPushedMsgId) {
        pushedBoundaryIdx = allMsgs.findIndex(m => m.id === binding.lastPushedMsgId);
    }
    const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:9999; display:flex; align-items:center; justify-content:center; padding:20px;';
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-color, #1a1a2e); border-radius:16px; padding:20px; width:100%; max-width:400px; max-height:85vh; display:flex; flex-direction:column;';

    // 预览：显示最近 count 条消息（与实际推送一致）；已推送行用灰色弱化，未推送用正常色，
    // 在分界处插入一条 "↑ 已推送 / ↓ 待推送" 的虚线，提示用户哪些会被重推
    function buildPreview(count) {
        const startIdx = Math.max(0, allMsgs.length - count);
        const msgs = allMsgs.slice(startIdx);
        const renderLine = (m) => {
            const text = m.content.length > 80 ? m.content.substring(0, 80) + '...' : m.content;
            return escapeHtml(text);
        };
        const out = [`&lt;phone_chat&gt;`];
        // 仅渲染最后 12 行，避免过长；若总数 > 12，前面用 ... 省略
        const renderStart = Math.max(0, msgs.length - 12);
        if (renderStart > 0) out.push(`<span style="color:#666;">... 省略前 ${renderStart} 条</span>`);
        for (let i = renderStart; i < msgs.length; i++) {
            const absIdx = startIdx + i;
            const isPushed = pushedBoundaryIdx >= 0 && absIdx <= pushedBoundaryIdx;
            // 在分界处（未推送的第一条之前）插入虚线
            if (i > renderStart) {
                const prevAbsIdx = startIdx + i - 1;
                const prevPushed = pushedBoundaryIdx >= 0 && prevAbsIdx <= pushedBoundaryIdx;
                if (prevPushed && !isPushed) {
                    out.push(`<span style="color:#888; font-size:11px; display:inline-block; padding:2px 0; border-top:1px dashed rgba(255,255,255,0.25); width:100%;">↑ 已推送 · ↓ 此次会重新推送</span>`);
                }
            }
            const line = renderLine(msgs[i]);
            if (isPushed) {
                out.push(`<span style="color:#777;">${line}</span>`);
            } else {
                out.push(`<span style="color:#cfe6ff;">${line}</span>`);
            }
        }
        out.push(`&lt;/phone_chat&gt;`);
        return out.join('\n');
    }

    const tabBtn = (id, label, active) => `<button data-mode="${id}" class="push-mode-tab" style="flex:1; padding:8px; border-radius:8px; border:1px solid rgba(255,255,255,0.15); background:${active ? 'rgba(33,150,243,0.18)' : 'transparent'}; color:${active ? '#2196F3' : 'inherit'}; font-size:13px; cursor:pointer;">${label}</button>`;

    modal.innerHTML = `
        <h3 style="margin:0 0 4px; font-size:16px; font-weight:600;">推送到酒馆</h3>
        <div style="font-size:11px; color:#888; margin-bottom:12px;">手动 · 不更新追踪基准（保留反悔余地）</div>
        <div style="display:flex; gap:6px; margin-bottom:12px;">
            ${tabBtn('raw', '原始消息', true)}
            ${tabBtn('summary', '小总结', false)}
        </div>

        <div id="mode-raw" style="display:flex; flex-direction:column;">
            <div style="display:flex; align-items:center; gap:10px; margin-bottom:10px;">
                <span style="font-size:14px; white-space:nowrap;">推送最近</span>
                <input type="number" id="push-count" value="${defaultCount}" min="1" max="${totalCount}"
                    style="width:70px; padding:6px 8px; border-radius:8px; border:1px solid rgba(255,255,255,0.2); background:transparent; color:inherit; font-size:14px; text-align:center;">
                <span style="font-size:14px; white-space:nowrap;">条 <span style="font-size:11px; color:#888;">（共 ${totalCount}）</span></span>
            </div>
            <div style="font-size:11px; color:#888; margin-bottom:6px;">用 &lt;phone_chat&gt; 标签包裹</div>
            <div id="push-preview" style="font-size:12px; background:rgba(255,255,255,0.04); border-radius:8px; padding:10px; margin-bottom:12px; max-height:200px; overflow-y:auto; white-space:pre-wrap; line-height:1.6; border-left:3px solid #2196F3;">${buildPreview(defaultCount)}</div>
        </div>

        <div id="mode-summary" style="display:none; flex-direction:column;">
            <div style="display:flex; align-items:center; gap:10px; margin-bottom:8px;">
                <span style="font-size:14px; white-space:nowrap;">总结最近</span>
                <input type="number" id="sum-count" value="${defaultCount}" min="1" max="${totalCount}"
                    style="width:70px; padding:6px 8px; border-radius:8px; border:1px solid rgba(255,255,255,0.2); background:transparent; color:inherit; font-size:14px; text-align:center;">
                <span style="font-size:14px; white-space:nowrap;">条 <span style="font-size:11px; color:#888;">（共 ${totalCount}）</span></span>
            </div>
            <div style="font-size:11px; color:#888; margin-bottom:10px;">用 API 把最近 N 条消息浓缩成一段总结后推送（不更新追踪基准，可重复推送）</div>
            <button id="summary-gen" style="${TS.btnB} width:100%; margin-bottom:10px;">生成小总结</button>
            <textarea id="summary-text" placeholder="生成后可在此编辑..." style="width:100%; box-sizing:border-box; min-height:140px; max-height:240px; padding:10px; border-radius:8px; border:1px solid rgba(255,255,255,0.15); background:rgba(255,255,255,0.04); color:inherit; font-size:13px; line-height:1.6; resize:vertical; margin-bottom:12px;"></textarea>
        </div>

        <div style="display:flex; gap:10px;">
            <button id="push-cancel" style="flex:1; padding:10px; border-radius:10px; border:1px solid rgba(255,255,255,0.15); background:transparent; color:inherit; cursor:pointer;">取消</button>
            <button id="push-confirm" style="flex:1; ${TS.btnP}">确认推送</button>
        </div>`;

    overlay.appendChild(modal); document.body.appendChild(overlay);

    let mode = 'raw';

    // 切换模式
    modal.querySelectorAll('.push-mode-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            mode = btn.dataset.mode;
            modal.querySelectorAll('.push-mode-tab').forEach(b => {
                const active = b.dataset.mode === mode;
                b.style.background = active ? 'rgba(33,150,243,0.18)' : 'transparent';
                b.style.color = active ? '#2196F3' : 'inherit';
            });
            modal.querySelector('#mode-raw').style.display = mode === 'raw' ? 'flex' : 'none';
            modal.querySelector('#mode-summary').style.display = mode === 'summary' ? 'flex' : 'none';
        });
    });

    // raw 模式：动态更新预览
    const countInput = modal.querySelector('#push-count');
    const previewEl = modal.querySelector('#push-preview');
    countInput.addEventListener('input', () => {
        let n = parseInt(countInput.value) || 1;
        if (n > totalCount) n = totalCount;
        if (n < 1) n = 1;
        previewEl.innerHTML = buildPreview(n);
    });

    // summary 模式：限制 count 输入范围 + API 生成
    const sumCountInput = modal.querySelector('#sum-count');
    const sumText = modal.querySelector('#summary-text');
    const genBtn = modal.querySelector('#summary-gen');
    let summaryState = null; // { text, coveredMsgIds } — 生成后填，count 改变时清空
    sumCountInput.addEventListener('input', () => {
        let n = parseInt(sumCountInput.value) || 1;
        if (n > totalCount) n = totalCount;
        if (n < 1) n = 1;
        sumCountInput.value = n;
        // count 变了就让用户重新生成，避免 coveredMsgIds 跟实际 N 不符
        if (summaryState) {
            summaryState = null;
            genBtn.textContent = '生成小总结';
        }
    });
    genBtn.addEventListener('click', async () => {
        let n = parseInt(sumCountInput.value) || defaultCount;
        if (n > totalCount) n = totalCount;
        if (n < 1) n = 1;
        genBtn.disabled = true; genBtn.textContent = '生成中...';
        try {
            const r = await TavernSync.summarizeUnpushedSlice(binding, { mode: 'lastN', count: n });
            summaryState = { text: r.text, coveredMsgIds: r.coveredMsgIds };
            sumText.value = r.text;
            genBtn.textContent = `重新生成（已覆盖 ${r.coveredCount} 条）`;
        } catch (e) {
            showToast(`${e.message}`);
            genBtn.textContent = '生成小总结';
        } finally { genBtn.disabled = false; }
    });

    modal.querySelector('#push-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

    modal.querySelector('#push-confirm').addEventListener('click', async () => {
        const confirmBtn = modal.querySelector('#push-confirm');
        confirmBtn.textContent = '推送中...'; confirmBtn.disabled = true;
        try {
            if (mode === 'summary') {
                const finalText = (sumText.value || '').trim();
                if (!finalText) { showToast('请先生成或填入总结文本'); confirmBtn.textContent = '确认推送'; confirmBtn.disabled = false; return; }
                // 优先用生成时锁定的 coveredMsgIds；用户没生成（直接手写）时按当前 N 取最近 N 条
                let coveredMsgIds, coveredCount;
                if (summaryState && Array.isArray(summaryState.coveredMsgIds) && summaryState.coveredMsgIds.length) {
                    coveredMsgIds = summaryState.coveredMsgIds;
                    coveredCount = coveredMsgIds.length;
                } else {
                    let n = parseInt(sumCountInput.value) || defaultCount;
                    if (n > totalCount) n = totalCount;
                    if (n < 1) n = 1;
                    coveredMsgIds = allMsgs.slice(-n).map(m => m.id);
                    coveredCount = n;
                }
                // 第三参传 null → 不更新 lastPushedMsgId（手动模式不追踪）
                const r = await TavernSync.pushSummaryToTavern(binding, finalText, null, coveredMsgIds);
                if (r.pushed > 0) {
                    try { window.webkit?.messageHandlers?.tavernPushDone?.postMessage({ message: r.message }); } catch {}
                }
                showToast(`已推送小总结 · 覆盖 ${coveredCount} 条（未更新追踪）`);
                overlay.remove();
            } else {
                const pushCount = parseInt(countInput.value) || defaultCount;
                // 手动原始推送不追踪基准点，保留反悔余地
                const r = await TavernSync.pushToTavern(binding, pushCount, false);
                if (r.pushed > 0 || r.deleted) {
                    try {
                        var payload = r.message ? { message: r.message } : { reload: true };
                        window.webkit?.messageHandlers?.tavernPushDone?.postMessage(payload);
                    } catch {}
                }
                showToast(`已推送 ${r.pushed} 条消息到酒馆（未更新追踪）${r.deleted ? '；已同步删除' : ''}`);
                overlay.remove();
            }
        } catch (e) {
            showToast(`${e.message}`);
            confirmBtn.textContent = '确认推送'; confirmBtn.disabled = false;
        }
    });
}

// ========== 正则规则编辑弹窗 ==========
function showRuleEditor(ruleIndex, onSave) {
    const cfg = TavernSync.getConfig(); if (!cfg.cleanRules) cfg.cleanRules = [];
    const existing = ruleIndex !== null ? cfg.cleanRules[ruleIndex] : null;
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:9999; display:flex; align-items:center; justify-content:center; padding:20px;';
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-color, #1a1a2e); border-radius:16px; padding:20px; width:100%; max-width:360px;';
    modal.innerHTML = `
        <h3 style="margin:0 0 16px; font-size:16px; font-weight:600;">${existing ? '编辑' : '添加'}清洗规则</h3>
        <div style="margin-bottom:12px;"><label style="${TS.label}">规则名称</label><input id="rr-name" placeholder="例如：去除thinking" style="${TS.input}"></div>
        <div style="margin-bottom:12px;"><label style="${TS.label}">正则表达式</label><input id="rr-regex" placeholder="例如：<thinking>[\\s\\S]*?</thinking>" style="${TS.input} font-family:monospace;"></div>
        <div style="margin-bottom:12px;"><label style="${TS.label}">模式</label><select id="rr-mode" style="${TS.input}">
            <option value="exclude" ${(!existing || existing.mode === 'exclude') ? 'selected' : ''}>排除（删除匹配内容）</option>
            <option value="extract" ${existing?.mode === 'extract' ? 'selected' : ''}>提取（只保留匹配/捕获组$1）</option></select></div>
        <div style="margin-bottom:12px;">
            <label style="${TS.label}">生效深度（从最新消息起算，0 = 最新一条）</label>
            <div style="display:flex; gap:8px; margin-top:4px;">
                <div style="flex:1;"><input id="rr-min-depth" type="number" min="0" value="${existing?.minDepth ?? ''}" placeholder="最小深度" style="${TS.input} text-align:center;"></div>
                <span style="align-self:center; color:#888;">~</span>
                <div style="flex:1;"><input id="rr-max-depth" type="number" min="0" value="${existing?.maxDepth ?? ''}" placeholder="最大深度" style="${TS.input} text-align:center;"></div>
            </div>
            <div style="font-size:11px; color:#888; margin-top:4px;">留空 = 不限。例如最小0最大4 = 只对最近5条生效；最小5留空 = 只对第6条及更早的生效</div>
        </div>
        <div style="margin-bottom:16px;"><label style="${TS.label}">测试</label>
            <textarea id="rr-test" placeholder="粘贴消息文本测试..." style="${TS.input} height:60px; resize:vertical;"></textarea>
            <div id="rr-result" style="margin-top:6px; font-size:12px; color:#888; background:rgba(255,255,255,0.04); border-radius:8px; padding:8px; white-space:pre-wrap; max-height:80px; overflow:auto;"></div></div>
        <div style="display:flex; gap:10px;">
            <button id="rr-cancel" style="flex:1; padding:10px; border-radius:10px; border:1px solid rgba(255,255,255,0.15); background:transparent; color:inherit; cursor:pointer;">取消</button>
            <button id="rr-save" style="flex:1; ${TS.btnP}">保存</button></div>`;
    overlay.appendChild(modal); document.body.appendChild(overlay);

    // 用 JS 赋值避免 HTML 属性转义导致正则乱码
    if (existing) {
        modal.querySelector('#rr-name').value = existing.name || '';
        modal.querySelector('#rr-regex').value = existing.regex || '';
    }

    function updateTest() {
        const regex = modal.querySelector('#rr-regex').value, mode = modal.querySelector('#rr-mode').value, text = modal.querySelector('#rr-test').value, res = modal.querySelector('#rr-result');
        if (!regex || !text) { res.textContent = ''; return; }
        try { const re = new RegExp(regex, 'gs');
            if (mode === 'extract') { const m = [...text.matchAll(re)]; res.textContent = m.length ? m.map(x => x[1] !== undefined ? x[1] : x[0]).join('\n') : '（无匹配）'; }
            else res.textContent = text.replace(re, '') || '（全部删除）';
        } catch (e) { res.textContent = `正则错误: ${e.message}`; }
    }
    ['#rr-test', '#rr-regex'].forEach(s => modal.querySelector(s).addEventListener('input', updateTest));
    modal.querySelector('#rr-mode').addEventListener('change', updateTest);
    modal.querySelector('#rr-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    modal.querySelector('#rr-save').addEventListener('click', async () => {
        const regex = modal.querySelector('#rr-regex').value; if (!regex) { showToast('请填写正则'); return; }
        try { new RegExp(regex); } catch { showToast('正则无效'); return; }
        const minD = modal.querySelector('#rr-min-depth').value, maxD = modal.querySelector('#rr-max-depth').value;
        const rule = { id: existing?.id || `rule_${Date.now()}`, name: modal.querySelector('#rr-name').value.trim() || '未命名', regex, mode: modal.querySelector('#rr-mode').value, enabled: existing?.enabled ?? true, minDepth: minD !== '' ? parseInt(minD) : null, maxDepth: maxD !== '' ? parseInt(maxD) : null };
        const cfg = TavernSync.getConfig(); if (!cfg.cleanRules) cfg.cleanRules = [];
        if (ruleIndex !== null) cfg.cleanRules[ruleIndex] = rule; else cfg.cleanRules.push(rule);
        await TavernSync.saveConfig(cfg); overlay.remove(); showToast('规则已保存'); if (onSave) onSave();
    });
}

// ========== 导入角色设定弹窗 ==========
async function showImportCharModal(binding) {
    const result = await TavernSync.importCharSettings(binding);
    const char = db.characters.find(c => c.id === binding.uwuCharId);
    if (!char) { showToast('找不到角色'); return; }

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:9999; display:flex; align-items:center; justify-content:center; padding:20px;';
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-color, #1a1a2e); border-radius:16px; padding:20px; width:100%; max-width:400px; max-height:80vh; overflow-y:auto;';

    const hasPersona = char.persona?.trim();
    const hasMyPersona = char.myPersona?.trim();

    let userPersonaHTML = '';
    if (result.userPersonas.length) {
        const opts = result.userPersonas.map(p => `<option value="${p.avatar}">${p.name}</option>`).join('');
        userPersonaHTML = `
            <div style="margin-bottom:12px;">
                <div style="display:flex; align-items:center; justify-content:space-between;">
                    <label style="${TS.label} margin-bottom:0;">用户人设（"我"的设定）</label>
                    ${hasMyPersona ? '<span style="font-size:11px; color:#FF9800;">将覆盖</span>' : ''}
                </div>
                <select id="ic-persona-select" style="${TS.input} margin-top:4px;">
                    <option value="">-- 选择要导入的用户人设 --</option>
                    <option value="__active__">当前激活的人设</option>
                    ${opts}
                </select>
                <textarea id="ic-mypersona" style="${TS.input} height:80px; resize:vertical; margin-top:6px; font-size:12px;" placeholder="选择人设后显示内容..."></textarea>
                <label style="display:flex; align-items:center; gap:6px; margin-top:6px; font-size:13px;">
                    <input type="checkbox" id="ic-mypersona-check" checked> 导入用户人设
                </label>
            </div>`;
    }

    modal.innerHTML = `
        <h3 style="margin:0 0 16px; font-size:16px; font-weight:600;">导入设定：${result.charName}</h3>
        ${result.charPersona ? `
            <div style="margin-bottom:12px;">
                <div style="display:flex; align-items:center; justify-content:space-between;">
                    <label style="${TS.label} margin-bottom:0;">角色人设</label>
                    ${hasPersona ? '<span style="font-size:11px; color:#FF9800;">将覆盖</span>' : ''}
                </div>
                <textarea id="ic-persona" style="${TS.input} height:120px; resize:vertical; margin-top:4px; font-size:12px;">${result.charPersona}</textarea>
                <label style="display:flex; align-items:center; gap:6px; margin-top:6px; font-size:13px;">
                    <input type="checkbox" id="ic-persona-check" checked> 导入角色人设
                </label>
            </div>` : '<div style="color:#888; font-size:13px; margin-bottom:12px;">酒馆角色无人设描述</div>'}
        ${userPersonaHTML}
        ${result.postHistory ? `
            <div style="margin-bottom:12px;">
                <label style="${TS.label}">Post History Instructions</label>
                <textarea id="ic-posthistory" style="${TS.input} height:60px; resize:vertical; font-size:12px;" readonly>${result.postHistory}</textarea>
                <div style="font-size:11px; color:#888; margin-top:4px;">（仅供参考，不自动导入）</div>
            </div>` : ''}
        <div style="display:flex; gap:10px;">
            <button id="ic-cancel" style="flex:1; padding:10px; border-radius:10px; border:1px solid rgba(255,255,255,0.15); background:transparent; color:inherit; cursor:pointer;">取消</button>
            <button id="ic-save" style="flex:1; ${TS.btnP}">确认导入</button>
        </div>`;

    overlay.appendChild(modal); document.body.appendChild(overlay);

    const personaSelect = modal.querySelector('#ic-persona-select');
    const myPersonaArea = modal.querySelector('#ic-mypersona');
    if (personaSelect) {
        personaSelect.addEventListener('change', () => {
            const val = personaSelect.value;
            if (val === '__active__') myPersonaArea.value = result.activePersona;
            else if (val) { const p = result.userPersonas.find(x => x.avatar === val); myPersonaArea.value = p?.description || ''; }
            else myPersonaArea.value = '';
        });
    }

    modal.querySelector('#ic-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

    modal.querySelector('#ic-save').addEventListener('click', async () => {
        const importPersona = modal.querySelector('#ic-persona-check')?.checked;
        const importMyPersona = modal.querySelector('#ic-mypersona-check')?.checked;

        if (importPersona && result.charPersona) {
            if (hasPersona && !confirm('当前角色已有人设，确定覆盖吗？')) { /* skip */ }
            else char.persona = modal.querySelector('#ic-persona').value;
        }
        if (importMyPersona && myPersonaArea?.value?.trim()) {
            if (hasMyPersona && !confirm('当前角色已有用户人设，确定覆盖吗？')) { /* skip */ }
            else char.myPersona = myPersonaArea.value;
        }

        await saveData(); overlay.remove(); showToast('设定已导入');
    });
}

// ========== 世界书弹窗（角色世界书 + 聊天世界书） ==========
async function showWorldBookModal(binding) {
    const char = db.characters.find(c => c.id === binding.uwuCharId);
    if (!char) { showToast('找不到角色'); return; }

    const worldBooks = await TavernSync.getCharAndChatWorldBooks(binding);
    const sources = [];
    if (worldBooks.charWorld) sources.push({ type: '角色世界书', ...worldBooks.charWorld });
    if (worldBooks.chatWorld) sources.push({ type: '聊天世界书', ...worldBooks.chatWorld });

    if (!sources.length) { showToast('该角色没有关联的世界书'); return; }

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:9999; display:flex; align-items:center; justify-content:center; padding:20px;';
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-color, #1a1a2e); border-radius:16px; padding:20px; width:100%; max-width:420px; max-height:80vh; display:flex; flex-direction:column;';

    const tabsHTML = sources.length > 1
        ? sources.map((src, i) => `<button class="wb-tab" data-tab="${i}" style="padding:6px 12px; border-radius:6px; border:1px solid rgba(255,255,255,0.15); background:${i === 0 ? 'rgba(255,255,255,0.15)' : 'transparent'}; color:inherit; font-size:12px; cursor:pointer;">${src.type}(${src.entries.length})</button>`).join('')
        : '';

    const bound = binding.boundWorldBook || null;
    const boundUidSet = bound ? new Set(bound.entryUids || []) : null;
    const boundHint = bound
        ? `<div style="font-size:11px; color:#888; margin-bottom:6px;">已绑定 ${bound.entryUids.length} 条（${bound.sourceName}）· 自动同步酒馆时会跟着刷新</div>`
        : `<div style="font-size:11px; color:#888; margin-bottom:6px;">勾选条目后点"绑定记忆"，每次同步酒馆都会自动跟着刷新内容</div>`;

    modal.innerHTML = `
        <h3 style="margin:0 0 8px; font-size:16px; font-weight:600;">世界书</h3>
        ${tabsHTML ? `<div style="display:flex; gap:6px; margin-bottom:10px; flex-wrap:wrap;">${tabsHTML}</div>` : ''}
        <div style="display:flex; gap:8px; margin-bottom:8px;">
            <button id="wb-select-all" style="padding:4px 10px; border-radius:6px; border:1px solid rgba(255,255,255,0.15); background:transparent; color:inherit; font-size:12px; cursor:pointer;">全选</button>
            <button id="wb-select-enabled" style="padding:4px 10px; border-radius:6px; border:1px solid rgba(255,255,255,0.15); background:transparent; color:inherit; font-size:12px; cursor:pointer;">仅已启用</button>
        </div>
        <div id="wb-entries" style="flex:1; overflow-y:auto; margin-bottom:8px;"></div>
        ${boundHint}
        <div style="display:flex; gap:8px; margin-bottom:8px;">
            <button id="wb-bind" style="flex:1; ${TS.btnG}">${bound ? '更新绑定' : '绑定记忆'}</button>
            <button id="wb-import" style="flex:1; ${TS.btnB}">添加到世界书</button>
        </div>
        ${bound ? `<button id="wb-unbind" style="width:100%; padding:8px; border-radius:8px; border:1px solid rgba(244,67,54,0.4); background:transparent; color:#f44; font-size:12px; cursor:pointer; margin-bottom:8px;">解除绑定</button>` : ''}
        <button id="wb-close" style="width:100%; padding:10px; border-radius:10px; border:1px solid rgba(255,255,255,0.15); background:transparent; color:inherit; font-size:14px; cursor:pointer;">关闭</button>`;

    overlay.appendChild(modal); document.body.appendChild(overlay);

    let currentSourceIdx = 0;
    function renderEntries(srcIdx) {
        currentSourceIdx = srcIdx;
        const src = sources[srcIdx];
        const entries = src.entries;
        // 绑定来源匹配当前 tab 时，按 boundUidSet 勾选；否则默认按是否禁用
        const matchesBound = bound && (
            (bound.sourceType === 'chat' && /聊天/.test(src.type)) ||
            (bound.sourceType === 'char' && /角色/.test(src.type))
        );
        const container = modal.querySelector('#wb-entries');
        container.innerHTML = entries.map((e, i) => {
            const checked = matchesBound ? boundUidSet.has(e.uid) : !e.disabled;
            return `
            <label style="display:flex; align-items:flex-start; gap:8px; padding:8px; background:rgba(255,255,255,0.04); border-radius:8px; margin-bottom:4px; cursor:pointer; ${e.disabled ? 'opacity:0.5;' : ''}">
                <input type="checkbox" data-idx="${i}" ${checked ? 'checked' : ''} style="flex-shrink:0; margin-top:2px;">
                <div style="flex:1; min-width:0;">
                    <div style="font-size:13px; font-weight:500;">${e.comment}${e.disabled ? ' (禁用)' : ''}</div>
                    <div style="font-size:11px; color:#888; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${e.content.substring(0, 80)}...</div>
                </div>
            </label>`;
        }).join('');
        modal.querySelectorAll('.wb-tab').forEach((t, i) => t.style.background = i === srcIdx ? 'rgba(255,255,255,0.15)' : 'transparent');
    }
    // 若已有绑定，初始切到对应 tab；否则默认 0
    let initIdx = 0;
    if (bound) {
        const findIdx = sources.findIndex(s =>
            (bound.sourceType === 'chat' && /聊天/.test(s.type)) ||
            (bound.sourceType === 'char' && /角色/.test(s.type))
        );
        if (findIdx >= 0) initIdx = findIdx;
    }
    renderEntries(initIdx);

    modal.querySelectorAll('.wb-tab').forEach(tab => tab.addEventListener('click', () => renderEntries(parseInt(tab.dataset.tab))));

    function getSelectedEntries() {
        const cbs = modal.querySelectorAll('#wb-entries input[type=checkbox]:checked');
        return [...cbs].map(cb => sources[currentSourceIdx].entries[parseInt(cb.dataset.idx)]);
    }
    modal.querySelector('#wb-select-all').addEventListener('click', () => modal.querySelectorAll('#wb-entries input[type=checkbox]').forEach(cb => cb.checked = true));
    modal.querySelector('#wb-select-enabled').addEventListener('click', () => {
        const entries = sources[currentSourceIdx].entries;
        modal.querySelectorAll('#wb-entries input[type=checkbox]').forEach((cb, i) => cb.checked = !entries[i].disabled);
    });

    modal.querySelector('#wb-bind').addEventListener('click', async () => {
        const cbs = modal.querySelectorAll('#wb-entries input[type=checkbox]:checked');
        const selected = [...cbs].map(cb => sources[currentSourceIdx].entries[parseInt(cb.dataset.idx)]);
        if (!selected.length) { showToast('请勾选条目'); return; }
        selected.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        const memoryText = selected.map(e => { let t = ''; if (e.comment) t += `[${e.comment}]\n`; t += e.content; return t; }).join('\n\n---\n\n');

        // 写入 binding：记下 source 和 entry uids，下次 pullFromTavern 自动按这套刷新
        const srcType = /聊天/.test(sources[currentSourceIdx].type) ? 'chat' : 'char';
        binding.boundWorldBook = {
            sourceType: srcType,
            sourceName: sources[currentSourceIdx].name,
            entryUids: selected.map(e => e.uid),
        };
        char.tavernWorldMemory = { lastSync: Date.now(), entryCount: selected.length, source: sources[currentSourceIdx].name, content: memoryText, bound: true };
        await TavernSync.saveConfig(TavernSync.getConfig());
        await saveData();
        showToast(`已绑定 ${selected.length} 条 · 之后同步酒馆会自动刷新`);
        overlay.remove();
    });

    if (bound) {
        modal.querySelector('#wb-unbind').addEventListener('click', async () => {
            delete binding.boundWorldBook;
            await TavernSync.saveConfig(TavernSync.getConfig());
            showToast('已解除绑定（已注入的记忆保留，不再自动刷新）');
            overlay.remove();
        });
    }

    modal.querySelector('#wb-import').addEventListener('click', async () => {
        const selected = getSelectedEntries();
        if (!selected.length) { showToast('请勾选条目'); return; }
        const categoryName = char.remarkName || char.realName || char.name || sources[currentSourceIdx].name;
        let addedCount = 0;
        for (const e of selected) {
            const newWb = { id: `wb_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, name: e.comment || '未命名', content: e.content, position: (e.position === 0) ? 'before' : 'after', category: categoryName };
            db.worldBooks.push(newWb);
            if (!char.worldBookIds) char.worldBookIds = [];
            if (!char.worldBookIds.includes(newWb.id)) char.worldBookIds.push(newWb.id);
            addedCount++;
        }
        await saveData(); showToast(`已添加 ${addedCount} 条世界书（分类: ${categoryName}）`);
    });

    modal.querySelector('#wb-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

// ========== 提示词预览弹窗 ==========
function showPromptPreview(binding) {
    const char = db.characters.find(c => c.id === binding.uwuCharId);
    if (!char) { showToast('找不到角色'); return; }

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:9999; display:flex; align-items:center; justify-content:center; padding:20px;';
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-color, #1a1a2e); border-radius:16px; padding:20px; width:100%; max-width:420px; max-height:80vh; display:flex; flex-direction:column;';

    const tsConfig = TavernSync.getConfig();
    const wbPosition = tsConfig.worldBookPosition || 'before_chat';

    let sections = [];

    const favJournals = (typeof window.getFavoritedJournalsForAi === 'function'
        ? window.getFavoritedJournalsForAi(char)
        : (char.memoryJournals || []).filter(j => j.isFavorited));
    if (favJournals.length) {
        sections.push({ title: '共同回忆', content: favJournals.map(j => `标题：${j.title}\n内容：${j.content}`).join('\n---\n'), color: '#4CAF50' });
    }

    const wbSection = char.tavernWorldMemory?.content ? { title: '世界观设定（酒馆世界书）', content: char.tavernWorldMemory.content, color: '#FF9800', meta: `来源: ${char.tavernWorldMemory.source} · ${char.tavernWorldMemory.entryCount} 条` } : null;

    // 剧情记忆预览：尽量按 AI 实际看到的来 ——
    // 有 floors → 用 filterFloorsForInjection 过滤后再渲染（user 注入开关在这里生效）
    // 没有 floors → 退回老的扁平 content（这是注入前的全量，无法按 user 角色过滤）
    let chatSection = null;
    if (char.tavernMemory) {
        const _hasFloors = Array.isArray(char.tavernMemory.floors) && char.tavernMemory.floors.length > 0;
        if (_hasFloors) {
            const _injectFloors = (typeof window !== 'undefined' && typeof window.filterFloorsForInjection === 'function')
                ? window.filterFloorsForInjection(char.tavernMemory.floors)
                : char.tavernMemory.floors;
            const _injectUserOff = (typeof db !== 'undefined' && db.tavernSync && db.tavernSync.injectUserFloors === false);
            const _previewLines = _injectFloors.map(f => {
                const meta = [f.storyTime, f.weekday, f.location, f.weather, f.mood].filter(Boolean).join(' · ');
                const who = f.role === 'user' ? (char.myName || '我') : (char.realName || char.name);
                const head = meta ? `[${meta} · ${who}]` : `[${who}]`;
                return `${head}\n${f.content || ''}`;
            }).join('\n\n');
            chatSection = {
                title: '剧情记忆（酒馆聊天）',
                content: _previewLines || '（floors 过滤后为空）',
                color: '#2196F3',
                meta: `${_injectFloors.length} / ${char.tavernMemory.floors.length} 条楼层${_injectUserOff ? '（已跳过 user 楼层）' : ''} · ${new Date(char.tavernMemory.lastSync).toLocaleString('zh-CN')}`
            };
        } else if (char.tavernMemory.content) {
            chatSection = {
                title: '剧情记忆（酒馆聊天）',
                content: char.tavernMemory.content,
                color: '#2196F3',
                meta: `${char.tavernMemory.messageCount} 条消息 · ${new Date(char.tavernMemory.lastSync).toLocaleString('zh-CN')}`
            };
        }
    }

    if (wbPosition === 'before_chat') {
        if (wbSection) sections.push(wbSection);
        if (chatSection) sections.push(chatSection);
    } else {
        if (chatSection) sections.push(chatSection);
        if (wbSection) sections.push(wbSection);
    }

    if (!sections.length) {
        sections.push({ title: '无酒馆数据', content: '尚未同步任何酒馆数据到记忆中。', color: '#999' });
    }

    // 粗略 token 估算：中文约 1.5 字符/token，英文/数字约 4 字符/token
    function estimateTokens(text) {
        if (!text) return 0;
        let cjk = 0, other = 0;
        for (const ch of text) { if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) cjk++; else other++; }
        return Math.ceil(cjk / 1.5 + other / 4);
    }

    // 每个 section 计算 token
    sections.forEach(s => { s.tokens = estimateTokens(s.content); });
    const totalTokens = sections.reduce((sum, s) => sum + s.tokens, 0);

    modal.innerHTML = `
        <h3 style="margin:0 0 12px; font-size:16px; font-weight:600;">提示词预览 — ${char.remarkName || char.name}</h3>
        <div style="font-size:12px; color:#888; margin-bottom:12px;">以下内容会在 &lt;memoir&gt; 标签中发送给 AI · 预估总计 <span style="color:#4CAF50; font-weight:600;">~${totalTokens.toLocaleString()}</span> tokens</div>
        <div style="flex:1; overflow-y:auto; margin-bottom:12px;">
            ${sections.map(s => `
                <div style="margin-bottom:12px;">
                    <div style="display:flex; align-items:center; gap:6px; margin-bottom:6px;">
                        <span style="width:8px; height:8px; border-radius:50%; background:${s.color}; flex-shrink:0;"></span>
                        <span style="font-size:13px; font-weight:600; color:${s.color};">${s.title}</span>
                        <span style="font-size:11px; color:#888; margin-left:auto;">~${s.tokens.toLocaleString()} tokens</span>
                    </div>
                    ${s.meta ? `<div style="font-size:11px; color:#888; margin-bottom:4px;">${s.meta}</div>` : ''}
                    <div style="font-size:12px; color:#ccc; background:rgba(255,255,255,0.04); border-radius:8px; padding:10px; white-space:pre-wrap; max-height:200px; overflow-y:auto; line-height:1.5; border-left:3px solid ${s.color};">${s.content.length > 2000 ? s.content.substring(0, 2000) + '\n\n... (已截断，共 ' + s.content.length + ' 字符)' : s.content}</div>
                </div>
            `).join('')}
        </div>
        <div style="font-size:12px; color:#888; margin-bottom:8px;">
            角色人设: ${char.persona ? char.persona.substring(0, 50) + '...' : '无'}<br>
            用户人设: ${char.myPersona ? char.myPersona.substring(0, 50) + '...' : '无'}
        </div>
        <button id="pp-close" style="width:100%; padding:10px; border-radius:10px; border:1px solid rgba(255,255,255,0.15); background:transparent; color:inherit; font-size:14px; cursor:pointer;">关闭</button>`;

    overlay.appendChild(modal); document.body.appendChild(overlay);
    modal.querySelector('#pp-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

// ========== 绑定编辑弹窗 ==========
async function showBindingEditor(onSave) {
    let stCharacters;
    try { stCharacters = await TavernSync.getSTCharacters(); } catch (e) { showToast(`${e.message}`); return; }
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:9999; display:flex; align-items:center; justify-content:center; padding:20px;';
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-color, #1a1a2e); border-radius:16px; padding:20px; width:100%; max-width:360px;';
    modal.innerHTML = `
        <h3 style="margin:0 0 16px; font-size:16px; font-weight:600;">添加角色绑定</h3>
        <div style="margin-bottom:12px;"><label style="${TS.label}">小手机角色</label>
            <select id="be-uwu" style="${TS.input}">${db.characters.map(c => `<option value="${c.id}">${c.remarkName || c.name}</option>`).join('')}</select></div>
        <div style="margin-bottom:12px;"><label style="${TS.label}">酒馆角色</label>
            <select id="be-st" style="${TS.input}">${stCharacters.map(c => `<option value="${c.avatar}">${c.name}</option>`).join('')}</select></div>
        <div style="margin-bottom:16px;"><label style="${TS.label}">酒馆聊天记录</label>
            <select id="be-chat" style="${TS.input}"><option>加载中...</option></select></div>
        <div style="display:flex; gap:10px;">
            <button id="be-cancel" style="flex:1; padding:10px; border-radius:10px; border:1px solid rgba(255,255,255,0.15); background:transparent; color:inherit; cursor:pointer;">取消</button>
            <button id="be-save" style="flex:1; ${TS.btnP}">保存</button></div>`;
    overlay.appendChild(modal); document.body.appendChild(overlay);
    const stSelect = modal.querySelector('#be-st'), chatSelect = modal.querySelector('#be-chat');
    async function loadChats() {
        if (!stSelect.value) return; chatSelect.innerHTML = '<option>加载中...</option>';
        try { const chats = await TavernSync.getSTChats(stSelect.value);
            chatSelect.innerHTML = chats?.length ? chats.map(c => `<option value="${c.file_name.replace('.jsonl', '')}">${c.file_name}</option>`).join('') : '<option value="">暂无聊天</option>';
        } catch { chatSelect.innerHTML = '<option value="">加载失败</option>'; }
    }
    stSelect.addEventListener('change', loadChats); loadChats();
    modal.querySelector('#be-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    modal.querySelector('#be-save').addEventListener('click', async () => {
        const binding = { uwuCharId: modal.querySelector('#be-uwu').value, stCharAvatar: stSelect.value, stChatFile: chatSelect.value };
        if (!binding.uwuCharId || !binding.stCharAvatar) { showToast('请选择角色'); return; }
        const cfg = TavernSync.getConfig(); if (!cfg.bindings) cfg.bindings = [];
        cfg.bindings.push(binding); await TavernSync.saveConfig(cfg);
        overlay.remove(); showToast('绑定已保存'); if (onSave) onSave();
    });
}

window.setupTavernSyncScreen = setupTavernSyncScreen;
window.TavernSync = TavernSync;
window.showAutoPushModal = showAutoPushModal;
// 注册页面可见性同步
TavernSync.setupVisibilitySync();
