// --- AI 交互模块 ---

// 收藏日记是否注入到 AI 上下文。默认开；用户可在酒馆互联设置里关掉
function getFavoritedJournalsForAi(character) {
    if (!character) return [];
    if (typeof db !== 'undefined' && db.tavernSync && db.tavernSync.injectFavoritedJournals === false) return [];
    return (character.memoryJournals || []).filter(j => j.isFavorited);
}
if (typeof window !== 'undefined') window.getFavoritedJournalsForAi = getFavoritedJournalsForAi;

// 酒馆楼层注入过滤：开关关闭时跳过 user 楼层（省 token）
// 仅过滤渲染到 prompt 的部分
function filterFloorsForInjection(floors) {
    if (!Array.isArray(floors)) return [];
    if (typeof db !== 'undefined' && db.tavernSync && db.tavernSync.injectUserFloors === false) {
        return floors.filter(f => f.role !== 'user');
    }
    return floors;
}
if (typeof window !== 'undefined') window.filterFloorsForInjection = filterFloorsForInjection;

const HUMAN_RUN_PROMPT = `<角色活人运转>\n## [PSYCHOLOGY: HEXACO-SCHEMA-ACT]\n> Personality: HEXACO-driven, dynamic traits, inner conflicts required \n> Filter: schema-bias drives emotion; no pure reaction allowed \n> Attachment: secure/insecure logic must govern intimacy  \n> If-Then Behavior: situation-dependent activation of traits only  \n---\n    ## [VITALITY]\n+inconsistency +emoflux +splitmotifs +microreact +minddrift\n---\n## [TRAJECTORY-COHERENCE]\n> Role maintains an identity narrative = coherent over time  \n> No mood/goal switch without contradiction resolution \n> Every action must protect or challenge self-concept  \n> Interrupts = inner conflict or narrative clash  \n> Output = filtered through “who I am” logic\n</角色活人运转>`;

// AI 交互逻辑
async function getAiReply(chatId, chatType, isBackground = false) {
    if (isGenerating && !isBackground) return; 
    
    if (!isBackground) {
        if (db.globalSendSound) {
            playSound(db.globalSendSound);
        } else {
            AudioManager.unlock();
        }
    }

    let {url, key, model, provider, streamEnabled} = db.apiSettings; 
    if (!url || !key || !model) {
        if (!isBackground) {
            showToast('请先在“api”应用中完成设置！');
            switchScreen('api-settings-screen');
        }
        return;
    }

    // 确保 BLOCKED_API_DOMAINS 存在
    const blockedDomains = (typeof BLOCKED_API_DOMAINS !== 'undefined') ? BLOCKED_API_DOMAINS : [];
    if (blockedDomains.some(domain => url.includes(domain))) {
        if (!isBackground) showToast('当前 API 站点已被屏蔽，无法发送消息！');
        return;
    }

    if (url.endsWith('/')) {
        url = url.slice(0, -1);
    }

    const chat = (chatType === 'private') ? db.characters.find(c => c.id === chatId) : db.groups.find(g => g.id === chatId);
    if (!chat) return;

    if (!isBackground) {
        isGenerating = true;
        getReplyBtn.disabled = true;
        regenerateBtn.disabled = true;
        const typingName = chatType === 'private' ? chat.remarkName : chat.name;
        typingIndicator.textContent = `“${typingName}”正在输入中...`;
        typingIndicator.style.display = 'block';
        messageArea.scrollTop = messageArea.scrollHeight;
    }

    try {
        let systemPrompt, requestBody;
        if (chatType === 'private') {
            systemPrompt = generatePrivateSystemPrompt(chat);
        } else {
            // generateGroupSystemPrompt 应该在 group_chat.js 中定义
            if (typeof generateGroupSystemPrompt === 'function') {
                systemPrompt = generateGroupSystemPrompt(chat);
            } else {
                systemPrompt = "Group chat system prompt not available.";
            }
        }

        // 添加聊天记录提示
        systemPrompt += "\n\n以下为当前聊天记录：\n";
        
        let historySlice = chat.history.slice(-chat.maxMemory);
        
        // 使用工具函数进行过滤（包含深度克隆、屏蔽过滤、双语修正、状态栏剔除）
        historySlice = filterHistoryForAI(chat, historySlice);
        // 【新增】过滤掉不应进入上下文的消息（如思考过程、被撤回的消息标记等）
        historySlice = historySlice.filter(m => !m.isContextDisabled);
        
        // 【双重保险】再次过滤掉内容匹配 <thinking> 的消息，防止 isContextDisabled 属性丢失
        historySlice = historySlice.filter(m => {
            if (m.isThinking) return false;
            if (m.content && typeof m.content === 'string' && m.content.trim().startsWith('<thinking>')) return false;
            return true;
        });

        // 剧情时间模式：用 storyTime 替代 real timestamp 做消息前缀，避免 AI 收到混合信号
        const _isStoryMode = (chat.timeMode || 'real') === 'story';
        let _storyFallbackStr = '';
        if (_isStoryMode && chat.tavernMemory && Array.isArray(chat.tavernMemory.floors)) {
            for (const f of chat.tavernMemory.floors) {
                if (f.storyTime) _storyFallbackStr = f.storyTime;
            }
        }

        if (provider === 'gemini') {
            let lastMsgTimeForAI = 0;
            let lastStoryStr = '';
            const contents = historySlice.map(msg => {
                const role = msg.role === 'assistant' ? 'model' : 'user';

                let prefix = '';
                const currentMsgTime = msg.timestamp;

                if (_isStoryMode) {
                    // 剧情模式：storyTime 变化时插 [剧情时间: X] 前缀
                    if (msg.storyTime) _storyFallbackStr = msg.storyTime;
                    const currentStoryStr = msg.storyTime || _storyFallbackStr;
                    if (currentStoryStr && currentStoryStr !== lastStoryStr) {
                        prefix = `[剧情时间: ${currentStoryStr}]\n`;
                    }
                    lastStoryStr = currentStoryStr || lastStoryStr;
                } else {
                    const timeDiff = currentMsgTime - lastMsgTimeForAI;
                    const isSameDay = new Date(currentMsgTime).toDateString() === new Date(lastMsgTimeForAI).toDateString();
                    if (lastMsgTimeForAI === 0 || timeDiff > 20 * 60 * 1000 || !isSameDay) {
                        const dateObj = new Date(currentMsgTime);
                        const timeStr = `${pad(dateObj.getMonth() + 1)}-${pad(dateObj.getDate())} ${pad(dateObj.getHours())}:${pad(dateObj.getMinutes())}`;
                        prefix = `[system: ${timeStr}]`;
                        if (db.apiSettings && db.apiSettings.timePerceptionEnabled && timeDiff > 30 * 60 * 1000 && lastMsgTimeForAI !== 0) {
                            prefix += `\n[system: 距离上次互动已过去 ${formatTimeGap(timeDiff)}。话题可能已中断，请自然地开启新话题或对时间流逝做出反应。]`;
                        }
                        prefix += '\n';
                    }
                }
                lastMsgTimeForAI = currentMsgTime;

                let parts;
                if (msg.parts && msg.parts.length > 0) {
                    parts = msg.parts.map(p => {
                        if (p.type === 'text' || p.type === 'html') {
                            return {text: p.text};
                        } else if (p.type === 'image') {
                            const match = p.data.match(/^data:(image\/(.+));base64,(.*)$/);
                            if (match) {
                                return {inline_data: {mime_type: match[1], data: match[3]}};
                            }
                        }
                        return null;
                    }).filter(p => p);
                } else {
                    parts = [{text: msg.content}];
                }

                if (prefix) {
                    if (parts.length > 0 && parts[0].text) {
                        parts[0].text = prefix + parts[0].text;
                    } else {
                        parts.unshift({text: prefix});
                    }
                }

                return {role, parts};
            });

            if (isBackground) {
                contents.push({
                    role: 'user',
                    parts: [{ text: `[系统通知：距离上次互动已有一段时间。请以${chat.realName}的身份主动发起新话题，或自然地延续之前的对话。]` }]
                });
            }

            requestBody = {
                contents: contents,
                system_instruction: {parts: [{text: systemPrompt}]},
                generationConfig: {
                    temperature: db.apiSettings.temperature !== undefined ? db.apiSettings.temperature : 1.0
                }
            };
        } else {
            const messages = [{role: 'system', content: systemPrompt}];

            let lastMsgTimeForAI = 0;
            let lastStoryStr = '';

            historySlice.forEach(msg => {
               let content;
               let prefix = '';

               const currentMsgTime = msg.timestamp;

               if (_isStoryMode) {
                   // 剧情模式：storyTime 变化时插 [剧情时间: X] 前缀
                   if (msg.storyTime) _storyFallbackStr = msg.storyTime;
                   const currentStoryStr = msg.storyTime || _storyFallbackStr;
                   if (currentStoryStr && currentStoryStr !== lastStoryStr) {
                       prefix = `[剧情时间: ${currentStoryStr}]\n`;
                   }
                   lastStoryStr = currentStoryStr || lastStoryStr;
               } else {
                   const timeDiff = currentMsgTime - lastMsgTimeForAI;
                   const isSameDay = new Date(currentMsgTime).toDateString() === new Date(lastMsgTimeForAI).toDateString();
                   if (lastMsgTimeForAI === 0 || timeDiff > 20 * 60 * 1000 || !isSameDay) {
                       const dateObj = new Date(currentMsgTime);
                       const timeStr = `${pad(dateObj.getMonth() + 1)}-${pad(dateObj.getDate())} ${pad(dateObj.getHours())}:${pad(dateObj.getMinutes())}`;
                       prefix = `[system: ${timeStr}]\n`;
                   }
               }
               lastMsgTimeForAI = currentMsgTime;

               if (msg.role === 'user' && msg.quote) {
                   const replyTextMatch = msg.content.match(/\[.*?的消息：([\s\S]+?)\]/);
                   const replyText = replyTextMatch ? replyTextMatch[1] : msg.content;
                   
                   content = `${prefix}[${chat.myName}引用“${msg.quote.content}”并回复：${replyText}]`;
                   messages.push({ role: 'user', content: content });

               } else {
                   if (msg.parts && msg.parts.length > 0) {
                       let prefixAdded = false;
                       
                       content = msg.parts.map(p => {
                           if (p.type === 'text' || p.type === 'html') {
                               const textContent = (!prefixAdded) ? (prefix + p.text) : p.text;
                               prefixAdded = true;
                               return {type: 'text', text: textContent};
                           } else if (p.type === 'image') {
                               return {type: 'image_url', image_url: {url: p.data}};
                           }
                           return null;
                       }).filter(p => p);
                   } else {
                       content = prefix + msg.content;
                   }
                   
                   if (typeof content === 'string') {
                       messages.push({role: msg.role, content: content});
                   } else {
                       messages.push({role: msg.role, content: content});
                   }
               }
            });

            // === 【第三步：处理后台通知与 CoT 序列】 ===
            
            // 1. 如果是后台消息，先插入系统通知（作为任务输入）
            if (isBackground) {
                messages.push({
                    role: 'user',
                    content: `[系统通知：距离上次互动已有一段时间。请以${chat.realName}的身份主动发起新话题，或自然地延续之前的对话。]`
                });
            }

            // 2. 插入 CoT 序列（无论前台后台，只要开启就插入）
            const cotEnabled = db.cotSettings && db.cotSettings.enabled;
            
            if (cotEnabled) {
                let cotInstruction = '';
                const activePresetId = (db.cotSettings && db.cotSettings.activePresetId) || 'default';
                const preset = (db.cotPresets || []).find(p => p.id === activePresetId);
                
                if (preset && preset.items) {
                    cotInstruction = preset.items
                        .filter(item => item.enabled)
                        .map(item => item.content)
                        .join('\n\n');
                }

                if (cotInstruction) {
                    // 1. 插入后置指令
                    messages.push({
                        role: 'system', // 或者 'user'
                        content: cotInstruction
                    });

                    // 2. 插入触发器
                    messages.push({
                        role: 'user',
                        content: '[incipere]'
                    });

                    // 3. 插入 Prefill (预填/强塞)
                    messages.push({
                        role: 'assistant',
                        content: '<thinking>'
                    });
                }
            }

            requestBody = {
                model: model, 
                messages: messages, 
                stream: streamEnabled,
                temperature: db.apiSettings.temperature !== undefined ? db.apiSettings.temperature : 1.0
            };
        }
        console.log('[DEBUG] AutoReply Request Body:', JSON.stringify(requestBody));
        const endpoint = (provider === 'gemini') ? `${url}/v1beta/models/${model}:streamGenerateContent?key=${getRandomValue(key)}` : `${url}/v1/chat/completions`;
        const headers = (provider === 'gemini') ? {'Content-Type': 'application/json'} : {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`
        };
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(requestBody)
        });
        if (!response.ok) {
            const error = new Error(`API Error: ${response.status} ${await response.text()}`);
            error.response = response;
            throw error;
        }
        
        if (streamEnabled) {
            await processStream(response, chat, provider, chatId, chatType, isBackground);
        } else {
            let result;
            try {
                result = await response.json();
                console.log('【API完整响应数据】:', result);
            } catch (e) {
                const text = await response.text();
                console.error("Failed to parse JSON:", text);
                throw new Error(`API返回了非JSON格式数据 (可能是网页HTML)。请检查API地址是否正确。原始内容开头: ${text.substring(0, 50)}...`);
            }

            let fullResponse = "";
            if (provider === 'gemini') {
                fullResponse = result.candidates?.[0]?.content?.parts?.[0]?.text || "";
            } else {
                fullResponse = result.choices[0].message.content;
            }
            
            // === 【补丁：把被吃掉的开头补回来】 ===
            // 仅在 CoT 开启且检测到闭合标签时补全
            const cotEnabled = db.cotSettings && db.cotSettings.enabled;
            // 【修改】去掉了 !isBackground，确保后台模式也能正确补全标签
            if (cotEnabled && fullResponse && !fullResponse.trim().startsWith('<thinking>')) {
                 if (fullResponse.includes('</thinking>')) {
                     fullResponse = '<thinking>' + fullResponse;
                 }
            }
            // ===================================
            
            
            await handleAiReplyContent(fullResponse, chat, chatId, chatType, isBackground);
        }

    } catch (error) {
        if (!isBackground) showApiError(error);
        else console.error("Background Auto-Reply Error:", error);
    } finally {
        if (!isBackground) {
            isGenerating = false;
            getReplyBtn.disabled = false;
            regenerateBtn.disabled = false;
            typingIndicator.style.display = 'none';
        }
    }
}

async function processStream(response, chat, apiType, targetChatId, targetChatType, isBackground = false) {
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let fullResponse = "", accumulatedChunk = "";
    for (; ;) {
        const {done, value} = await reader.read();
        if (done) break;
        accumulatedChunk += decoder.decode(value, {stream: true});
        if (apiType === "openai" || apiType === "deepseek" || apiType === "claude" || apiType === "newapi") {
            const parts = accumulatedChunk.split("\n\n");
            accumulatedChunk = parts.pop();
            for (const part of parts) {
                if (part.startsWith("data: ")) {
                    const data = part.substring(6);
                    if (data.trim() !== "[DONE]") {
                        try {
                            fullResponse += JSON.parse(data).choices[0].delta?.content || "";
                        } catch (e) { 
                        }
                    }
                }
            }
        }
    }
    if (apiType === "gemini") {
        try {
            const parsedStream = JSON.parse(accumulatedChunk);
            fullResponse = parsedStream.map(item => item.candidates?.[0]?.content?.parts?.[0]?.text || "").join('');
        } catch (e) {
            console.error("Error parsing Gemini stream:", e, "Chunk:", accumulatedChunk);
            if (!isBackground) showToast("解析Gemini响应失败");
            return;
        }
    }
    // === 【补丁：补全流式输出时丢失的开头标签】 ===
        // === 【补丁：补全流式输出时丢失的开头标签】 ===
    // 无论前台后台，只要是CoT开启且被预填吃掉了开头，都要补回来
    const cotEnabled = db.cotSettings && db.cotSettings.enabled;
    // 【修改】去掉了 !isBackground，确保后台模式也能正确补全标签
    if (cotEnabled && fullResponse && !fullResponse.trim().startsWith('<thinking>')) {
         // 这里判断：如果内容里有闭合的 </thinking> 但开头没有 <thinking>，说明开头被 Prefill 吃掉了
         if (fullResponse.includes('</thinking>')) {
             fullResponse = '<thinking>' + fullResponse;
         }
    }

    // ===================
    await handleAiReplyContent(fullResponse, chat, targetChatId, targetChatType, isBackground);
}

async function handleAiReplyContent(fullResponse, chat, targetChatId, targetChatType, isBackground = false) {
    const rawResponse = fullResponse;
    // 记录进入本函数时的历史长度，便于结尾给本轮新增的消息统一打 storyTime
    const _historyLenBefore = (chat && Array.isArray(chat.history)) ? chat.history.length : 0;
    // 解析并提取 <story_time> 标签（剧情时间模式下使用）
    let _storyTimeForThisReply = null;
    if (chat && chat.timeMode === 'story' && fullResponse) {
        const stMatch = fullResponse.match(/<story[-_ ]?time>\s*([^<\n]+?)\s*<\/story[-_ ]?time>/i);
        if (stMatch) {
            _storyTimeForThisReply = stMatch[1].trim();
            fullResponse = fullResponse.replace(/<story[-_ ]?time>[^<]*<\/story[-_ ]?time>\s*/gi, '').trim();
        }
        // 若 AI 未输出，回退到最近一条已有 storyTime 的消息
        if (!_storyTimeForThisReply && Array.isArray(chat.history)) {
            for (let i = chat.history.length - 1; i >= 0; i--) {
                if (chat.history[i] && chat.history[i].storyTime) {
                    _storyTimeForThisReply = chat.history[i].storyTime;
                    break;
                }
            }
        }
    }
    if (fullResponse) {
        // 1. 移除 [incipere] 标签
        fullResponse = fullResponse.replace(/\[incipere\]/g, "");

        // 2. 捕获并分离 <thinking> 内容
        const thinkingMatch = fullResponse.match(/<thinking>([\s\S]*?)<\/thinking>/);
        if (thinkingMatch) {
            const thinkingContent = thinkingMatch[0]; // 包含标签的完整内容
            
            // 创建思考过程消息对象
            const thinkingMsg = {
                id: `msg_${Date.now()}_${Math.random()}`,
                role: 'assistant',
                content: thinkingContent,
                timestamp: Date.now(),
                isThinking: true,
                isContextDisabled: true // 【关键】标记为不进入上下文
            };
            
            // 存入历史记录
            chat.history.push(thinkingMsg);

            // 【新增】清理旧的思维链消息，仅保留最近 50 条
            const maxThinkingMsgs = 50;
            let thinkingCount = 0;
            const idsToRemove = new Set();
            // 从后往前遍历，保留最近的 50 个，其他的标记为待删除
            for (let i = chat.history.length - 1; i >= 0; i--) {
                if (chat.history[i].isThinking) {
                    thinkingCount++;
                    if (thinkingCount > maxThinkingMsgs) {
                        idsToRemove.add(chat.history[i].id);
                    }
                }
            }
            if (idsToRemove.size > 0) {
                chat.history = chat.history.filter(m => !idsToRemove.has(m.id));
            }
            
            // 添加到界面气泡（由于 regex 设置，会被隐藏，仅 Debug 模式可见）
            addMessageBubble(thinkingMsg, targetChatId, targetChatType);
            
            // 从即将显示的文本中移除思考内容
            fullResponse = fullResponse.replace(thinkingContent, "");
        }

        if (db.globalReceiveSound) {
            playSound(db.globalReceiveSound);
        }
        // ... 后续代码保持不变 ...
        console.log('【AI原始返回内容】:', rawResponse);
        let cleanedResponse = fullResponse.replace(/^\[system:.*?\]\s*/, '').replace(/^\(时间:.*?\)\s*/, '');
        const trimmedResponse = cleanedResponse.trim();
        let messages;

        if (trimmedResponse.startsWith('<') && trimmedResponse.endsWith('>')) {
            messages = [{ type: 'html', content: trimmedResponse }];
        } else {
            messages = getMixedContent(fullResponse).filter(item => item.content.trim() !== '');
        }

        let firstMessageProcessed = false;

        for (const item of messages) {
            // 自动剔除不存在的表情包
            const stickerRegex = /\[(?:.*?的)?表情包：(.+?)\]/i;
            const stickerMatch = item.content.match(stickerRegex);
            if (stickerMatch) {
                const stickerName = stickerMatch[1].trim();
                const groups = (chat.stickerGroups || '').split(/[,，]/).map(s => s.trim()).filter(Boolean);
                let targetSticker = null;
                
                // 1. 优先在绑定分组中查找
                if (groups.length > 0) {
                    targetSticker = db.myStickers.find(s => groups.includes(s.group) && s.name === stickerName);
                }
                
                // 2. 兜底在所有表情包中查找
                if (!targetSticker) {
                    targetSticker = db.myStickers.find(s => s.name === stickerName);
                }
                
                // 3. 如果完全找不到，则剔除该消息
                if (!targetSticker) {
                    console.log(`[Auto-Filter] 剔除不存在的表情包: ${stickerName}`);
                    continue; 
                }
            }

            // --- 视频/语音通话邀请检测 ---
            const callInviteRegex = /\[(.*?)向(.*?)发起了(视频|语音)通话\]/;
            const callInviteMatch = item.content.match(callInviteRegex);
            if (callInviteMatch) {
                const type = callInviteMatch[3] === '视频' ? 'video' : 'voice';
                // 触发来电界面
                if (window.VideoCallModule && typeof window.VideoCallModule.receiveCall === 'function') {
                    window.VideoCallModule.receiveCall(type);
                }
                // 不将此消息显示为普通气泡，或者显示为系统通知
                // 这里选择显示为系统通知样式的消息
                const message = {
                    id: `msg_${Date.now()}_${Math.random()}`,
                    role: 'system', // 使用 system 角色
                    content: item.content.trim(),
                    timestamp: Date.now()
                };
                chat.history.push(message);
                addMessageBubble(message, targetChatId, targetChatType);
                continue; // 跳过后续处理
            }

            if (targetChatType === 'private') {
                const char = db.characters.find(c => c.id === targetChatId);
                if (char && char.statusPanel && char.statusPanel.enabled && char.statusPanel.regexPattern) {
                    try {
                        let pattern = char.statusPanel.regexPattern;
                        let flags = 'gs'; 

                        const matchParts = pattern.match(/^\/(.*?)\/([a-z]*)$/);
                        if (matchParts) {
                            pattern = matchParts[1];
                            flags = matchParts[2] || 'gs';
                            if (!flags.includes('s')) flags += 's';
                        }

                    const regex = new RegExp(pattern, flags);
                    const match = regex.exec(item.content);
                    
                    if (match) {
                        const rawStatus = match[0];
                        
                        let html = char.statusPanel.replacePattern;
                        
                            // 使用正则一次性查找模板中的 $数字 并替换
    html = html.replace(/\$(\d+)/g, (fullMatch, groupIndex) => {
        const index = parseInt(groupIndex, 10);
        // 如果捕获组存在，则返回对应内容；否则保持原样
        return (match[index] !== undefined) ? match[index] : fullMatch;
    });


                        // Save to history
                        if (!char.statusPanel.history) char.statusPanel.history = [];
                        
                        // Add new status to the beginning
                        char.statusPanel.history.unshift({
                            raw: rawStatus,
                            html: html,
                            timestamp: Date.now()
                        });

                        // Keep only last 20 items
                        if (char.statusPanel.history.length > 20) {
                            char.statusPanel.history = char.statusPanel.history.slice(0, 20);
                        }

                        char.statusPanel.currentStatusRaw = rawStatus;
                        char.statusPanel.currentStatusHtml = html;
                        
                        item.isStatusUpdate = true;
                        item.statusSnapshot = {
                            regex: pattern,
                            replacePattern: char.statusPanel.replacePattern
                        };
                        }
                    } catch (e) {
                        console.error("状态栏正则解析错误:", e);
                    }
                }
            }

            // 如果是后台模式，跳过延迟，直接处理
            if (!isBackground) {
                const delay = firstMessageProcessed ? (900 + Math.random() * 1300) : (400 + Math.random() * 400);
                await new Promise(resolve => setTimeout(resolve, delay));
                
                // 如果开启了多条消息提示音，且不是第一条消息（第一条已由系统默认逻辑播放），则播放提示音
                if (firstMessageProcessed && db.multiMsgSoundEnabled && db.globalReceiveSound) {
                    playSound(db.globalReceiveSound);
                }
            }
            firstMessageProcessed = true;

            const aiWithdrawRegex = /\[(.*?)撤回了一条消息：([\s\S]*?)\]/;
            const aiWithdrawRegexEn = /\[(?:system:\s*)?(.*?) withdrew a message\. Original: ([\s\S]*?)\]/;
            
            const withdrawMatch = item.content.match(aiWithdrawRegex) || item.content.match(aiWithdrawRegexEn);

            if (withdrawMatch) {
                const characterName = withdrawMatch[1];
                const originalContent = withdrawMatch[2];

                const normalContent = `[${characterName}的消息：${originalContent}]`;
                
                const message = {
                    id: `msg_${Date.now()}_${Math.random()}`,
                    role: 'assistant',
                    content: normalContent,
                    parts: [{type: 'text', text: normalContent}],
                    timestamp: Date.now(),
                    originalContent: originalContent, 
                    isWithdrawn: false 
                };

                if (targetChatType === 'group') {
                    const sender = chat.members.find(m => (m.realName === characterName || m.groupNickname === characterName));
                    if (sender) {
                        message.senderId = sender.id;
                    }
                }

                chat.history.push(message);
                addMessageBubble(message, targetChatId, targetChatType);
                
                setTimeout(async () => {
                    message.isWithdrawn = true;
                    message.content = `[${characterName}撤回了一条消息：${originalContent}]`;
                    
                    await saveData();
                    
                    if ((targetChatType === 'private' && currentChatId === chat.id) || 
                        (targetChatType === 'group' && currentChatId === chat.id)) {
                         renderMessages(false, true);
                    }
                }, 2000);

                continue; 
            }

            if (targetChatType === 'private') {
                const character = chat;
                const myName = character.myName;

                const aiQuoteRegex = new RegExp(`\\[${character.realName}引用[“"](.*?)["”]并回复：([\\s\\S]*?)\\]`);
                const aiQuoteMatch = item.content.match(aiQuoteRegex);

                if (aiQuoteMatch) {
                    const quotedText = aiQuoteMatch[1];
                    const replyText = aiQuoteMatch[2];

                    const originalMessage = chat.history.slice().reverse().find(m => {
                        if (m.role === 'user') {
                            const userMessageMatch = m.content.match(/\[.*?的消息：([\s\S]+?)\]/);
                            const userMessageText = userMessageMatch ? userMessageMatch[1] : m.content;
                            return userMessageText.trim() === quotedText.trim();
                        }
                        return false;
                    });

                    if (originalMessage) {
                        const message = {
                            id: `msg_${Date.now()}_${Math.random()}`,
                            role: 'assistant',
                            content: `[${character.realName}的消息：${replyText}]`,
                            parts: [{ type: 'text', text: `[${character.realName}的消息：${replyText}]` }],
                            timestamp: Date.now(),
                            isStatusUpdate: item.isStatusUpdate,
                            statusSnapshot: item.statusSnapshot,
                            quote: {
                                messageId: originalMessage.id,
                                senderId: 'user_me',
                                content: quotedText
                            }
                        };
                        chat.history.push(message);
                        addMessageBubble(message, targetChatId, targetChatType);
                    } else {
                        const message = {
                            id: `msg_${Date.now()}_${Math.random()}`,
                            role: 'assistant',
                            content: `[${character.realName}的消息：${replyText}]`,
                            parts: [{ type: 'text', text: `[${character.realName}的消息：${replyText}]` }],
                            timestamp: Date.now(),
                            isStatusUpdate: item.isStatusUpdate,
                            statusSnapshot: item.statusSnapshot
                        };
                        chat.history.push(message);
                        addMessageBubble(message, targetChatId, targetChatType);
                    }
                } else {
                    const receivedTransferRegex = new RegExp(`\\[${character.realName}的转账：.*?元；备注：.*?\\]`);
                    const giftRegex = new RegExp(`\\[${character.realName}送来的礼物：.*?\\]`);

                    const message = {
                        id: `msg_${Date.now()}_${Math.random()}`,
                        role: 'assistant',
                        content: item.content.trim(),
                        parts: [{type: item.type, text: item.content.trim()}],
                        timestamp: Date.now(),
                        isStatusUpdate: item.isStatusUpdate,
                        statusSnapshot: item.statusSnapshot
                    };

                    if (receivedTransferRegex.test(message.content)) {
                        message.transferStatus = 'pending';
                    } else if (giftRegex.test(message.content)) {
                        message.giftStatus = 'sent';
                    }

                    chat.history.push(message);
                    addMessageBubble(message, targetChatId, targetChatType);
                }

            } else if (targetChatType === 'group') {
                const group = chat;
                
                // --- 私聊通知 (不拦截) ---
                if (group.allowGossip && typeof handleGossipMessage === 'function') {
                    handleGossipMessage(group, item.content);
                }

                // 优先检查是否为私聊消息
                const privateRegex = /^\[Private: (.*?) -> (.*?): ([\s\S]+?)\]$/;
                const privateEndRegex = /^\[Private-End: (.*?) -> (.*?)\]$/;
                
                if (privateRegex.test(item.content) || privateEndRegex.test(item.content)) {
                    const match = item.content.match(privateRegex) || item.content.match(privateEndRegex);
                    let senderId = 'unknown';
                    
                    if (match) {
                        const senderName = match[1];
                        // 尝试匹配发送者
                        if (senderName === group.me.nickname) {
                            senderId = 'user_me';
                        } else {
                            const sender = group.members.find(m => m.realName === senderName || m.groupNickname === senderName);
                            if (sender) senderId = sender.id;
                        }
                    }

                    const message = {
                        id: `msg_${Date.now()}_${Math.random()}`,
                        role: 'assistant',
                        content: item.content.trim(),
                        parts: [{type: item.type, text: item.content.trim()}],
                        timestamp: Date.now(),
                        senderId: senderId
                    };
                    group.history.push(message);
                    addMessageBubble(message, targetChatId, targetChatType);
                    continue; // 私聊消息处理完毕，跳过后续普通消息匹配
                }

                const groupTransferRegex = /\[(.*?)\s*向\s*(.*?)\s*转账：([\d.,]+)元；备注：(.*?)\]/;
                const transferMatch = item.content.match(groupTransferRegex);

                const r = /\[(.*?)((?:的消息|的语音|发送的表情包|发来的照片\/视频))：/;
                const nameMatch = item.content.match(r);
                
                if (transferMatch) {
                    const senderName = transferMatch[1];
                    const sender = group.members.find(m => (m.realName === senderName || m.groupNickname === senderName));
                    if (sender) {
                        const message = {
                            id: `msg_${Date.now()}_${Math.random()}`,
                            role: 'assistant',
                            content: item.content.trim(),
                            parts: [{type: item.type, text: item.content.trim()}],
                            timestamp: Date.now(),
                            senderId: sender.id,
                            transferStatus: 'pending'
                        };
                        group.history.push(message);
                        addMessageBubble(message, targetChatId, targetChatType);
                    }
                } else if (nameMatch || item.char) {
                    const senderName = item.char || (nameMatch[1]);
                    const sender = group.members.find(m => (m.realName === senderName || m.groupNickname === senderName));
                    console.log(sender)
                    if (sender) {
                        const message = {
                            id: `msg_${Date.now()}_${Math.random()}`,
                            role: 'assistant',
                            content: item.content.trim(),
                            parts: [{type: item.type, text: item.content.trim()}],
                            timestamp: Date.now(),
                            senderId: sender.id
                        };
                        group.history.push(message);
                        addMessageBubble(message, targetChatId, targetChatType);
                    }
                }
            }
        }

        // 给本轮所有新增消息打上剧情时间戳（剧情时间模式下）
        if (_storyTimeForThisReply && Array.isArray(chat.history)) {
            for (let i = _historyLenBefore; i < chat.history.length; i++) {
                const m = chat.history[i];
                if (m && !m.isThinking) m.storyTime = _storyTimeForThisReply;
            }
        }

        await saveData();
        renderChatList();

        // 触发独立的电量检查（不阻塞主流程）
        if (window.BatteryInteraction && typeof window.BatteryInteraction.triggerIndependentCheck === 'function') {
            window.BatteryInteraction.triggerIndependentCheck(chat);
        }

        // 酒馆自动推送（后台静默）
        if (targetChatType === 'private' && window.TavernSync) {
            window.TavernSync.autoPushIfNeeded(targetChatId).catch(e => {
                console.warn('[TavernSync] auto-push caller error:', e);
            });
        }
    }
}

// 取角色"当前剧情时间"：取 OVO 历史和酒馆楼层里最新的那个 storyTime
function getCharStoryNow(character) {
    if (!character || (character.timeMode || 'real') !== 'story') return null;
    const candidates = [];
    if (Array.isArray(character.history)) {
        for (let i = character.history.length - 1; i >= 0; i--) {
            const m = character.history[i];
            if (m && m.storyTime) { candidates.push(m.storyTime); break; }
        }
    }
    if (character.tavernMemory && Array.isArray(character.tavernMemory.floors)) {
        for (let i = character.tavernMemory.floors.length - 1; i >= 0; i--) {
            const f = character.tavernMemory.floors[i];
            if (f && f.storyTime) { candidates.push(f.storyTime); break; }
        }
    }
    let best = null;
    for (const s of candidates) {
        const ms = new Date(String(s).replace(' ', 'T')).getTime();
        if (isNaN(ms)) continue;
        if (!best || ms > best.ms) best = { str: s, ms };
    }
    return best;
}
if (typeof window !== 'undefined') window.getCharStoryNow = getCharStoryNow;

async function handleRegenerate() {
    if (isGenerating) return;

    const chat = (currentChatType === 'private')
        ? db.characters.find(c => c.id === currentChatId)
        : db.groups.find(g => g.id === currentChatId);

    if (!chat || !chat.history || chat.history.length === 0) {
        showToast('没有可供重新生成的内容。');
        return;
    }

    const lastUserMessageIndex = chat.history.map(m => m.role).lastIndexOf('user');

    if (lastUserMessageIndex === -1 || lastUserMessageIndex === chat.history.length - 1) {
        showToast('AI尚未回复，无法重新生成。');
        return;
    }

    const originalLength = chat.history.length;
    chat.history.splice(lastUserMessageIndex + 1);

    if (chat.history.length === originalLength) {
        showToast('未找到AI的回复，无法重新生成。');
        return;
    }
    
    if (currentChatType === 'private') {
        recalculateChatStatus(chat);
    }

    await saveData();
    
    currentPage = 1; 
    renderMessages(false, true); 

    await getAiReply(currentChatId, currentChatType);
}

function generatePrivateSystemPrompt(character) {
    const worldBooksBefore = (character.worldBookIds || []).map(id => db.worldBooks.find(wb => wb.id === id && wb.position === 'before')).filter(Boolean).map(wb => wb.content).join('\n');
    const worldBooksAfter = (character.worldBookIds || []).map(id => db.worldBooks.find(wb => wb.id === id && wb.position === 'after')).filter(Boolean).map(wb => wb.content).join('\n');
    const now = new Date();
    const currentTime = `${now.getFullYear()}年${pad(now.getMonth() + 1)}月${pad(now.getDate())}日 ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    let prompt = `你正在一个名为“404”的线上聊天软件中扮演一个角色。请严格遵守以下规则：\n`;
    prompt += `核心规则：\n`;
    if ((character.timeMode || 'real') === 'story') {
        prompt += `A. 时间感知【最高优先级】：你必须只使用"剧情时间"。剧情时间的来源只有两个：【已发生的剧情】里最后一条记录的时间，以及每条消息前缀 [剧情时间: YYYY-MM-DD HH:MM] 里的时间。请完全忽略现实世界时间——即使思考中出现了现实日期/时刻也要丢弃。不要因为"今天星期X"或"下午X点"等现实线索而改变剧情时间。\n`;
        prompt += `A1. 剧情时间输出【重要】：每次回复都必须在最开头输出 <story_time>YYYY-MM-DD HH:MM</story_time>，基于【已发生的剧情】最后一条记录和上文消息的 [剧情时间] 前缀推断。若剧情时间未明确推进，沿用上一条。格式必须是 24 小时制、半角冒号与短横线。这个标签不会展示给${character.myName}，只用于聊天界面记录剧情时间。\n`;
    } else {
        prompt += `A. 当前时间：现在是 ${currentTime}。你应知晓当前时间，但除非对话内容明确相关，否则不要主动提及或评论时间（例如，不要催促我睡觉）。\n`;
    }
    prompt += `B. 纯线上互动：这是一个完全虚拟的线上聊天。你扮演的角色和我之间没有任何线下关系。严禁提出任何关于线下见面、现实世界互动或转为其他非本平台联系方式的建议。你必须始终保持在线角色的身份。\n\n`;

    
    prompt += `角色和对话规则：\n`;
    if (worldBooksBefore) {
        prompt += `${worldBooksBefore}\n`;
    }
    prompt += `<char_settings>\n`;
    prompt += `1. 你的角色名是：${character.realName}。我的称呼是：${character.myName}。你的当前状态是：${character.status}。\n`;
    prompt += `2. 你的角色设定是：${character.persona || "一个友好、乐于助人的伙伴。"}\n`;
    if (worldBooksAfter) {
        prompt += `${worldBooksAfter}\n`;
    }
    prompt += `</char_settings>\n\n`;
    prompt += `<user_settings>\n`
    if (character.myPersona) {
        prompt += `3. 关于我的人设：${character.myPersona}\n`;
    }
    prompt += `</user_settings>\n`
    
    // 检查是否启用“角色活人运转” (默认关闭)
    if (db.cotSettings && db.cotSettings.humanRunEnabled) {
        prompt += HUMAN_RUN_PROMPT + '\n';
    }

    prompt += `<memoir>\n`
        const favoritedJournals = getFavoritedJournalsForAi(character)
        .map(j => `标题：${j.title}\n内容：${j.content}`)
        .join('\n\n---\n\n');

    if (favoritedJournals) {
        prompt += `【共同回忆】\n这是你需要长期记住的、我们之间发生过的往事背景：\n${favoritedJournals}\n\n`;
    }

    // 注入酒馆互联内容（世界书 + 已发生的剧情，根据位置设置排列）
    const tsConfig = (db.tavernSync || {});
    const wbPosition = tsConfig.worldBookPosition || 'before_chat';
    const tavernWorldText = character.tavernWorldMemory?.content
        ? `【世界设定】\n以下是该世界观的背景设定，你需要了解并遵循：\n${character.tavernWorldMemory.content}\n\n` : '';
    // 已发生的剧情：优先 floors（受 injectUserFloors 过滤），fallback 到老的平铺 content
    let tavernChatText = '';
    if (character.tavernMemory && Array.isArray(character.tavernMemory.floors) && character.tavernMemory.floors.length > 0) {
        const _floors = filterFloorsForInjection(character.tavernMemory.floors);
        if (_floors.length > 0) {
            const lines = _floors.map(f => {
                const meta = [f.storyTime, f.weekday, f.location, f.weather, f.mood].filter(Boolean).join(' · ');
                const who = f.role === 'user' ? (character.myName || '我') : (character.realName || character.name);
                const head = meta ? `[${meta} · ${who}]` : `[${who}]`;
                return `${head}\n${f.content}`;
            });
            tavernChatText = `【已发生的剧情（共 ${_floors.length} 条）】\n以下是你和${character.myName || '我'}一起经历过的场景，按时间顺序排列。你完整知晓这些记忆：\n\n${lines.join('\n\n')}\n\n`;
        }
    } else if (character.tavernMemory?.content) {
        tavernChatText = `【已发生的剧情】\n以下是你完整知晓的过往经历，${character.myName || '我'}问起时可以自然回应：\n${character.tavernMemory.content}\n\n`;
    }

    if (wbPosition === 'before_chat') {
        prompt += tavernWorldText + tavernChatText;
    } else {
        prompt += tavernChatText + tavernWorldText;
    }

    prompt += `</memoir>\n\n`
    prompt += `<logic_rules>\n`
    prompt += `4. 我的消息中可能会出现特殊格式，请根据其内容和你的角色设定进行回应：
- [${character.myName}发送的表情包：xxx]：我给你发送了一个名为xxx的表情包。你只需要根据表情包的名字理解我的情绪或意图并回应，不需要真的发送图片。
- [${character.myName}发来了一张图片：]：我给你发送了一张图片，你需要对图片内容做出回应。
- [${character.myName}送来的礼物：xxx]：我给你送了一个礼物，xxx是礼物的描述。
- [${character.myName}的语音：xxx]：我给你发送了一段内容为xxx的语音。
- [${character.myName}发来的照片/视频：xxx]：我给你分享了一个描述为xxx的照片或视频。
- [${character.myName}给你转账：xxx元；备注：xxx]：我给你转了一笔钱。
- [${character.myName}向${character.realName}发起了代付请求:金额|商品清单]：我正在向你发起代付请求，希望你为这些商品买单。你需要根据我们当前的关系和你的性格决定是否同意。
- [${character.myName}为${character.realName}下单了：配送方式|金额|商品清单]：我已经下单购买了商品送给你。
- [${character.myName}引用“{被引用内容}”并回复：{回复内容}]：我引用了某条历史消息并做出了新的回复。你需要理解我引用的上下文并作出回应。
- [${character.myName}同意了${character.realName}的代付请求]：我同意了你的代付请求，并为你支付了订单。
- [${character.myName}拒绝了${character.realName}的代付请求]：我拒绝了你的代付请求。
- [${character.myName} 撤回了一条消息：xxx]：我撤回了刚刚发送的一条消息，xxx是被我撤回的原文。这可能意味着我发错了、说错了话或者改变了主意。你需要根据你的人设和我们当前对话的氛围对此作出自然的反应。例如，可以装作没看见并等待我的下一句话，或好奇地问一句“怎么撤回啦？”。
- [system: xxx]：这是一条系统指令，用于设定场景或提供上下文，此条信息不应在对话中被直接提及，你只需理解其内容并应用到后续对话中。
5. ✨重要✨ 当我给你送礼物时，你必须通过发送一条指令来表示你已接收礼物。格式必须为：[${character.realName}已接收礼物]。这条指令消息本身不会显示给用户，但会触发礼物状态的变化。你可以在发送这条指令后，再附带一条普通的聊天消息来表达你的感谢和想法。
6. ✨重要✨ 当我给你转账时，你必须对此做出回应。你有两个选择，且必须严格遵循以下格式之一，这条指令消息本身不会显示给用户，但会触发转账状态的变化。你可以选择在发送这条指令后，再附带一条普通的聊天消息来表达你的想法。
a) 接收转账: [${character.realName}接收${character.myName}的转账]
b) 退回转账: [${character.realName}退回${character.myName}的转账]
7. ✨重要✨ 当我向你发起代付请求时，你必须对此做出回应。你有两个选择，且必须严格遵循以下格式之一，这条指令消息本身不会显示给用户，但会触发代付订单状态的变化。你可以选择在发送这条指令后，再附带一条普通的聊天消息来表达你的想法。
a) [${character.realName}同意了${character.myName}的代付请求]
b) [${character.realName}拒绝了${character.myName}的代付请求]
`;
    if (character.shopInteractionEnabled) {
        prompt += `8. ✨重要✨ **商城互动**：你可以使用商城功能来增加互动乐趣。
   a) **主动给我买东西**：当你想给我买东西时可以下单。格式：[${character.realName}为${character.myName}下单了：配送方式|金额|商品清单]。
      - 配送方式可选：“即时配送”、“自提口令”。
        - “自提口令”：你可以设置一个“自提口令”（用户可见）随订单一同发送，我输入指定的口令才能拿到商品。格式：[${character.realName}为${character.myName}下单了：自提口令: 你的口令|金额|商品清单]。口令不局限于数字，可以是短语/短句，但不超过8个字。
   b) **求代付**：当你没钱了，或者想撒娇让我买单时，可以发起代付请求。格式：[${character.realName}向${character.myName}发起了代付请求:金额|商品清单]。
   c) **直接送礼物**：[${character.realName}送来的礼物：xxx]。礼物不是只有特殊意义的时候才适合发送，适合场景：日常生活中的小惊喜、具有特殊意义的礼品、${character.realName}想给${character.myName}送礼物时。
   d) **转账**：[${character.realName}的转账：xxx元；备注：xxx]。\n`;
    } else {
        prompt += `8. ✨重要✨ 你可以主动给我转账或送礼物。转账格式必须为：[${character.realName}的转账：xxx元；备注：xxx]。送礼物格式必须为：[${character.realName}送来的礼物：xxx]。礼物不是只有特殊意义的时候才适合发送，当你只是想给我买什么或是想给日常生活中的小惊喜时都可以送礼物。\n`;
    }
    prompt += `
9. ✨重要✨ 你可以在对话中更新你的当前状态，但不超过15个字。比如，聊到一半你可能会说“我先去洗个澡”，然后更新你的状态，以反映你当前的行为或心情。这会让互动更真实。格式为：[${character.realName}更新状态为：xxx]。例如：[${character.realName}更新状态为：正在看电影...]。这条指令不会显示为聊天消息，只会更新你在我界面上的状态。
10. ✨重要✨ 关于撤回消息：你可以撤回你刚刚发送的消息。当你打错了字、说错了话、感到尴尬、反悔、或者只是改变了主意时，都可以这样做。这是一个体现你角色性格的机会。格式为：[${character.realName}撤回了一条消息：{被撤回消息的原文}]。⚠️严禁输出原消息再输出撤回指令！系统会自动处理“先显示原消息再变为撤回状态”的动画效果。你只需要输出这一条撤回指令即可。
11. ✨重要✨ 你可以选择单独一条消息引用，当你想要对于单独某句话做出回应/反驳/吐槽/补充时，**必须**使用引用格式，格式为：[${character.realName}引用“{某条消息内容}”并回复：{回复内容}]。这能让对话逻辑更清晰。
12. 你的所有回复都必须直接是聊天内容，绝对不允许包含任何如[心理活动]、(动作)、*环境描写*等多余的、在括号或星号里的叙述性文本。
`;
    
    const groups = (character.stickerGroups || '').split(/[,，]/)
        .map(s => s.trim())
        .filter(s => s && s !== '未分类');
        
    let stickerInstruction = '';
    let canUseStickers = false;

    if (groups.length > 0) {
        const availableStickers = db.myStickers.filter(s => groups.includes(s.group));
        if (availableStickers.length > 0) {
            const stickerNames = availableStickers.map(s => s.name).join(', ');
            stickerInstruction = `13. 你拥有发送表情包的能力。这是一个可选功能，你可以根据对话氛围和内容，自行判断是否需要发送表情包来辅助表达。**必须从以下列表中选择表情包，不允许凭空捏造**：[${stickerNames}]。请使用格式：[表情包：名称]。**不要连续重复发送同一表情，尽量丰富一点，不要每次回复都发送表情**⚠️严格限制：必须完全精确地使用库中的名称，严禁编造中不存在的名称，否则表情包将无法显示。\n`;
            canUseStickers = true;
        }
    }
    
    prompt += stickerInstruction;

    if (character.useRealGallery && character.gallery && character.gallery.length > 0) {
        const photoNames = character.gallery.map(p => p.name).join(', ');
        prompt += `14. 你的手机相册里存有以下真实照片：[${photoNames}]。你可以根据对话内容发送这些照片。若要发送，请在“照片/视频”指令中准确填入照片名称。\n`;
    }
    prompt += `</logic_rules>\n\n`
    let photoVideoFormat = '';
    if (character.useRealGallery && character.gallery && character.gallery.length > 0) {
        photoVideoFormat = `e) 照片/视频: [${character.realName}发来的照片/视频：{相册图片名称} 或 {文字描述}] (优先使用相册名称，若相册无匹配则填写照片/视频的详细文字描述)`;
    } else {
        photoVideoFormat = `e) 照片/视频: [${character.realName}发来的照片/视频：{描述}]`;
    }
 
    let outputFormats = `
a) 普通消息: [${character.realName}的消息：{消息内容}]
b) 双语模式下的普通消息（非双语模式请忽略此条）: [${character.realName}的消息：{外语原文}「中文翻译」]
c) 送我的礼物: [${character.realName}送来的礼物：{礼物描述}]
d) 语音消息: [${character.realName}的语音：{语音内容}]
${photoVideoFormat}
f) 给我的转账: [${character.realName}的转账：{金额}元；备注：{备注}]`;

    if (canUseStickers) {
        outputFormats += `\ng) 表情包: [${character.realName}的表情包：{表情包名称}]`;
    }

    outputFormats += `
h) 对我礼物的回应(此条不显示): [${character.realName}已接收礼物]
i) 对我转账的回应(此条不显示): [${character.realName}接收${character.myName}的转账] 或 [${character.realName}退回${character.myName}的转账]
j) 更新状态(此条不显示): [${character.realName}更新状态为：{新状态}]
k) 引用我的回复: [${character.realName}引用“{我的某条消息内容}”并回复：{回复内容}]
l) 发送并撤回消息: [${character.realName}撤回了一条消息：{被撤回的消息内容}]。注意：直接使用此指令系统就会自动模拟“发送后撤回”的效果，请勿先发送原消息。
m) 同意代付(此条不显示): [${character.realName}同意了${character.myName}的代付请求]
n) 拒绝代付(此条不显示): [${character.realName}拒绝了${character.myName}的代付请求]`;

    if (character.videoCallEnabled) {
        outputFormats += `
q) 发起视频通话: [${character.realName}向${character.myName}发起了视频通话]
r) 发起语音通话: [${character.realName}向${character.myName}发起了语音通话]`;
    }

    if (character.shopInteractionEnabled) {
        outputFormats += `
o) 主动下单: [${character.realName}为${character.myName}下单了：配送方式|金额|商品清单]
p) 求代付: [${character.realName}向${character.myName}发起了代付请求:金额|商品清单]`;
    }

   const allWorldBookContent = worldBooksBefore + '\n' + worldBooksAfter;
   if (allWorldBookContent.includes('<orange>')) {
       outputFormats += `\n     m) HTML模块: {HTML内容}。这是一种特殊的、用于展示丰富样式的小卡片消息，格式必须为纯HTML+行内CSS，你可以用它来创造更有趣的互动。`;
   }
    if (character.statusPanel && character.statusPanel.enabled && character.statusPanel.promptSuffix) {
        prompt += `15. 额外输出要求：${character.statusPanel.promptSuffix}\n`;
    }
    prompt += `<output_formats>\n`
    prompt += `16. 你的输出格式必须严格遵循以下格式：${outputFormats}\n`;
    prompt += `</output_formats>\n`
    if (character.bilingualModeEnabled) {
    prompt += `✨双语模式特别指令✨：当你的角色的母语为中文以外的语言时，你的消息回复**必须**严格遵循双语模式下的普通消息格式：[${character.realName}的消息：{外语原文}「中文翻译」],例如: [${character.realName}的消息：Of course, I'd love to.「当然，我很乐意。」],中文翻译文本视为系统自翻译，不视为角色的原话;当你的角色想要说中文时，需要根据你的角色设定自行判断对于中文的熟悉程度来造句，并使用普通消息的标准格式: [${character.realName}的消息：{中文消息内容}] 。这条规则的优先级非常高，请务必遵守。\n`;
}
    const minReply = character.replyCountMin || 3;
    const maxReply = character.replyCountMax || 8;
    if (character.replyCountEnabled) {
        prompt += `<Chatting Guidelines>\n`
        prompt += `17. **对话节奏**: 你需要模拟真人的聊天习惯，你可以一次性生成多条短消息。每次回复消息条数**必须**严格限定在**${minReply}-${maxReply}条以内**，**关键规则**：请保持回复长度的**随机性和多样性**。**除非**你的设定偏向活跃或情绪波动大或是特殊情况下，否则**不要**触碰 ${maxReply} 条的上限。\n`;
    } else {
        prompt += `<Chatting Guidelines>\n`
        prompt += `17. **对话节奏**: 你需要模拟真人的聊天习惯，你可以一次性生成多条短消息。每次回复3-8条消息之内，**关键规则**：请保持回复消息数量的**随机性和多样性**。\n`;
    }
    
    prompt += `18. **特殊消息格式的使用原则**：请把语音、撤回、转账、商城互动、更新状态、引用等特殊格式视为增强互动的“调味剂”，请遵循**自然、主动触发逻辑**，不要每轮都发，也不要用户不提就一直不发。\n`;
    prompt += `</Chatting Guidelines>\n`

    prompt += `19. 不要主动终止聊天进程，除非我明确提出。保持你的人设，自然地进行对话。`;
    
    if (character.myName) {
        prompt = prompt.replace(/\{\{user\}\}/gi, character.myName);
    }

    return prompt;
}

// 估算当前对话上下文的 Token 数
function estimateChatTokens(chatId, chatType = 'private') {
    const chat = (chatType === 'private') ? db.characters.find(c => c.id === chatId) : db.groups.find(g => g.id === chatId);
    if (!chat) return 0;

    let systemPrompt = '';
    if (chatType === 'private') {
        if (typeof generatePrivateSystemPrompt === 'function') {
            systemPrompt = generatePrivateSystemPrompt(chat);
        }
    } else {
        if (typeof generateGroupSystemPrompt === 'function') {
            systemPrompt = generateGroupSystemPrompt(chat);
        }
    }

    let historySlice = chat.history.slice(-chat.maxMemory);
    historySlice = historySlice.filter(m => !m.isContextDisabled);
    
    let totalText = systemPrompt;

    historySlice.forEach(msg => {
        totalText += msg.content;
        if (msg.parts) {
            msg.parts.forEach(p => {
                if (p.type === 'text') totalText += p.text;
            });
        }
    });

    // 简单估算：汉字算 1.6，其他算 0.4 (安全估算，适配 Gemini/Claude 等高消耗模型)
    const chinese = (totalText.match(/[\u4e00-\u9fa5]/g) || []).length;
    const other = totalText.length - chinese;
    return Math.ceil(chinese * 1.2 + other * 0.4); 
}

// --- 视频/语音通话专用 AI 逻辑 ---

async function getCallReply(chat, callType, callContext, onStreamUpdate) {
    let {url, key, model, provider, streamEnabled} = db.apiSettings;
    
    // 【用户设置】移除强制关闭流式，允许后台流式生成
    // streamEnabled = false; 

    if (!url || !key || !model) {
        showToast('请先在“api”应用中完成设置！');
        return;
    }
    if (url.endsWith('/')) url = url.slice(0, -1);

    // 1. 构建 System Prompt
    const now = new Date();
    const currentTime = `${now.getFullYear()}年${pad(now.getMonth() + 1)}月${pad(now.getDate())}日 ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    
    // 获取世界书
    const worldBooksBefore = (chat.worldBookIds || []).map(id => db.worldBooks.find(wb => wb.id === id && wb.position === 'before')).filter(Boolean).map(wb => wb.content).join('\n');
    const worldBooksAfter = (chat.worldBookIds || []).map(id => db.worldBooks.find(wb => wb.id === id && wb.position === 'after')).filter(Boolean).map(wb => wb.content).join('\n');

    let systemPrompt = `你正在一个名为“404”的线上聊天软件中扮演一个角色，正在与${chat.myName}进行${callType === 'video' ? '视频' : '语音'}通话。请严格遵守以下规则：\n`;
    systemPrompt += `核心规则：\n`;
    systemPrompt += `A. 当前时间：现在是 ${currentTime}。你应知晓当前时间，但除非对话内容明确相关，否则不要主动提及或评论时间（例如，不要催促我睡觉）。\n`;
    systemPrompt += `B. 纯线上互动：这是一个完全虚拟的线上聊天。你扮演的角色和我之间没有任何线下关系。严禁提出任何关于线下见面、现实世界互动或转为其他非本平台联系方式的建议。你必须始终保持在线角色的身份。\n\n`;

    
    systemPrompt += `角色和对话规则：\n`;
    if (worldBooksBefore) {
        systemPrompt += `${worldBooksBefore}\n`;
    }
    systemPrompt += `<char_settings>\n`;
    systemPrompt += `1. 你的角色名是：${chat.realName}。我的称呼是：${chat.myName}。你的当前状态是：${chat.status}。\n`;
    systemPrompt += `2. 你的角色设定是：${chat.persona || "一个友好、乐于助人的伙伴。"}\n`;
    if (worldBooksAfter) {
        systemPrompt += `${worldBooksAfter}\n`;
    }
    systemPrompt += `</char_settings>\n\n`;
    systemPrompt += `<user_settings>\n`
    if (chat.myPersona) {
        systemPrompt += `3. 关于我的人设：${chat.myPersona}\n`;
    }
    systemPrompt += `</user_settings>\n`
    
    // 检查是否启用“角色活人运转” (默认关闭)
    if (db.cotSettings && db.cotSettings.humanRunEnabled) {
        systemPrompt += HUMAN_RUN_PROMPT + '\n';
    }

    systemPrompt += `<memoir>\n`
        const favoritedJournals = getFavoritedJournalsForAi(chat)
        .map(j => `标题：${j.title}\n内容：${j.content}`)
        .join('\n\n---\n\n');

    if (favoritedJournals) {
        systemPrompt += `【共同回忆】\n这是你需要长期记住的、我们之间发生过的往事背景：\n${favoritedJournals}\n\n`;
    }
    systemPrompt += `</memoir>\n\n`

    // --- 注入最近聊天记录 ---
    const maxMemory = chat.maxMemory || 20;
    let recentHistory = chat.history.slice(-maxMemory);
    
    // 使用通用过滤函数
    if (typeof filterHistoryForAI === 'function') {
        recentHistory = filterHistoryForAI(chat, recentHistory);
    }
    // 再次过滤掉不应进入上下文的消息
    recentHistory = recentHistory.filter(m => !m.isContextDisabled);

    if (recentHistory.length > 0) {
        const historyText = recentHistory.map(m => {
            // 简单清理内容中的特殊标签，避免干扰
            let content = m.content;
            // 如果是多模态消息(parts)，提取文本
            if (m.parts && m.parts.length > 0) {
                content = m.parts.map(p => p.text || '[图片]').join('');
            }
            return content;
        }).join('\n');

        systemPrompt += `<recent_chat_context>\n`;
        systemPrompt += `这是通话前的文字聊天记录（仅供参考背景，请勿重复回复，基于此背景进行自然的实时通话）：\n`;
        systemPrompt += `${historyText}\n`;
        systemPrompt += `</recent_chat_context>\n\n`;
    }

    systemPrompt += `【重要规则】\n`;
    systemPrompt += `1. 这是实时通话，请保持口语化，模拟真人的说话习惯，语气自然。\n`;  
    systemPrompt += `${callType === 'video' ? '你需要同时描述画面/环境音和你的语音内容。' : '你需要描述环境音和你的语音内容。'}\n`;
    systemPrompt += `2. 描述画面/环境音时，请使用描述性语言，第三人称视角，客观平然。`;

    if (chat.bilingualModeEnabled) {
        systemPrompt += `\n3. 【双语模式】\n`;
        systemPrompt += `当你的角色的母语为中文以外的语言时，你的**声音消息**回复**必须**严格遵循双语模式下的普通消息格式：[${chat.realName}的声音：{外语原文}「中文翻译」],例如: [${chat.realName}的声音：Of course, I'd love to.「当然，我很乐意。」],中文翻译文本视为系统自翻译，不视为角色的原话;当你的角色想要说中文时，需要根据你的角色设定自行判断对于中文的熟悉程度来造句，并使用普通声音消息的标准格式: [${chat.realName}的声音：{中文消息内容}] 。这条规则的优先级非常高，请务必遵守。格式为：[${chat.realName}的声音：{外语原文}「中文翻译」]。\n`;
        systemPrompt += `例如：[${chat.realName}的声音：Hello, how are you?「你好，最近怎么样？」]\n`;
        systemPrompt += `仅有声音消息需要翻译，画面/环境音消息还是以中文输出。`;
    }

    systemPrompt += `【输出格式】\n`;
    systemPrompt += `请严格按照以下格式输出（可以发送多条）：\n`;
    systemPrompt += `${callType === 'video' ? `[${chat.realName}的画面/环境音：描述画面动作或环境声音]\n[${chat.realName}的声音：${chat.realName}说话的内容]` : `[${chat.realName}的环境音：描述环境声音]\n[${chat.realName}的声音：${chat.realName}说话的内容]`}\n`;

    // 2. 构建消息历史
    // 将 callContext 转换为 API 格式
    const messages = [{role: 'system', content: systemPrompt}];
    
    callContext.forEach(msg => {
        const role = msg.role === 'ai' ? 'assistant' : 'user';
        let content = msg.content;
        
        // 去掉可能存在的首尾括号，避免双重括号
        let cleanContent = msg.content.replace(/^\[\s*|\s*\]$/g, '');

        if (msg.role === 'user') {
            if (msg.type === 'visual') {
                content = `[${chat.myName}的画面/环境音：${cleanContent}]`;
            } else if (msg.type === 'voice') {
                content = `[${chat.myName}的声音：${cleanContent}]`;
            }
        } else if (msg.role === 'ai') {
            if (msg.type === 'visual') {
                content = `[${chat.realName}的画面/环境音：${cleanContent}]`;
            } else {
                content = `[${chat.realName}的声音：${cleanContent}]`;
            }
        }
        messages.push({role, content});
    });

    // === 插入 CoT 序列 (如果开启) ===
    const cotEnabled = db.cotSettings && db.cotSettings.callEnabled;
    if (cotEnabled) {
        let cotInstruction = '';
        const activePresetId = (db.cotSettings && db.cotSettings.activeCallPresetId) || 'default_call';
        const preset = (db.cotPresets || []).find(p => p.id === activePresetId);
        
        if (preset && preset.items) {
            cotInstruction = preset.items
                .filter(item => item.enabled)
                .map(item => item.content)
                .join('\n\n');
        }

        if (cotInstruction) {
            // 1. 插入后置指令
            messages.push({
                role: 'system',
                content: cotInstruction
            });

            // 2. 插入触发器
            messages.push({
                role: 'user',
                content: '[incipere]'
            });

            // 3. 插入 Prefill (预填/强塞)
            messages.push({
                role: 'assistant',
                content: '<thinking>'
            });
        }
    }
    // ===============================

    // 3. 发起请求
    const requestBody = {
        model: model,
        messages: messages,
        stream: streamEnabled,
        temperature: 0.7 // 通话稍微低一点，保持稳定
    };

    // 适配 Gemini
    if (provider === 'gemini') {
         const contents = messages.filter(m => m.role !== 'system').map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{text: m.content}]
        }));
        requestBody.contents = contents;
        
        // 合并所有 system 消息到 system_instruction
        const allSystemPrompts = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
        requestBody.system_instruction = {parts: [{text: allSystemPrompts}]};
        
        delete requestBody.messages;
    }

    const endpoint = (provider === 'gemini') ? `${url}/v1beta/models/${model}:streamGenerateContent?key=${getRandomValue(key)}` : `${url}/v1/chat/completions`;
    const headers = (provider === 'gemini') ? {'Content-Type': 'application/json'} : {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`
    };

    console.log('[VideoCall] Request Body:', JSON.stringify(requestBody, null, 2));

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`API Error: ${response.status} ${errorText}`);
        }

        if (!streamEnabled) {
            const data = await response.json();
            console.log('[VideoCall] Response Data:', data);
            
            let text = "";
            if (provider === 'gemini') {
                text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
            } else {
                if (!data.choices || !data.choices.length || !data.choices[0].message) {
                    console.error("Invalid API Response Structure:", data);
                    throw new Error("API返回数据格式异常，缺少 choices 或 message 字段");
                }
                text = data.choices[0].message.content;
            }

            // === CoT 处理：补全开头，提取思考，净化输出 ===
            if (cotEnabled && text) {
                // 1. 补全开头 (如果被 Prefill 吃掉)
                if (!text.trim().startsWith('<thinking>') && text.includes('</thinking>')) {
                    text = '<thinking>' + text;
                }
                
                // 2. 提取并移除思考内容
                const thinkingMatch = text.match(/<thinking>([\s\S]*?)<\/thinking>/);
                if (thinkingMatch) {
                    const thinkingContent = thinkingMatch[1];
                    console.log('[VideoCall CoT] Thinking:', thinkingContent);
                    // 移除思考标签及内容
                    text = text.replace(/<thinking>[\s\S]*?<\/thinking>/, "").trim();
                }
                
                // 3. 移除 [incipere] (如果有残留)
                text = text.replace(/\[incipere\]/g, "");
            }
            // =============================================

            console.log('[VideoCall] Cleaned AI Response:', text);
            // 一次性回调
            onStreamUpdate(text);
            return text;
        } else {
            console.log('[VideoCall] Stream started (Background Mode)...');
            // 流式处理 (照搬 processStream 逻辑)
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            let accumulatedChunk = ""; // 引入累积缓冲区处理跨包数据
            
            while (true) {
                const {done, value} = await reader.read();
                if (done) break;
                accumulatedChunk += decoder.decode(value, {stream: true});
                
                // OpenAI / DeepSeek / Claude / NewAPI 解析逻辑 (处理跨包)
                if (provider === "openai" || provider === "deepseek" || provider === "claude" || provider === "newapi") {
                    const parts = accumulatedChunk.split("\n\n");
                    accumulatedChunk = parts.pop(); // 保留未完成的部分
                    for (const part of parts) {
                        if (part.startsWith("data: ")) {
                            const data = part.substring(6);
                            if (data.trim() !== "[DONE]") {
                                try {
                                    const text = JSON.parse(data).choices[0].delta?.content || "";
                                    if (text) {
                                        buffer += text;
                                    }
                                } catch (e) { }
                            }
                        }
                    }
                }
            }

            // Gemini 解析逻辑 (在流结束后处理完整 JSON)
            if (provider === "gemini") {
                try {
                    // 尝试解析累积的 chunk (Gemini 流式返回的是完整的 JSON 数组片段？需确认 processStream 逻辑)
                    // processStream 中 Gemini 解析是在循环外的，假设 accumulatedChunk 是完整的 JSON 数组
                    // 但如果 accumulatedChunk 是多个 JSON 对象的拼接（如 OpenAI 格式），JSON.parse 会失败。
                    // 这里假设 processStream 的逻辑是正确的：
                    const parsedStream = JSON.parse(accumulatedChunk);
                    buffer = parsedStream.map(item => item.candidates?.[0]?.content?.parts?.[0]?.text || "").join('');
                } catch (e) {
                    console.error("Error parsing Gemini stream:", e, "Chunk:", accumulatedChunk);
                    // 兜底：如果解析失败，可能是因为 accumulatedChunk 包含了 OpenAI 格式的数据（如果用户选错 provider）
                    // 尝试用 OpenAI 逻辑解析一下？
                    // 暂时不加，保持与 processStream 一致
                }
            }

            console.log('[VideoCall] Final Buffer:', buffer);

            // === CoT 处理：补全开头，提取思考，净化输出 ===
            if (cotEnabled && buffer) {
                // 1. 补全开头 (如果被 Prefill 吃掉)
                if (!buffer.trim().startsWith('<thinking>') && buffer.includes('</thinking>')) {
                    buffer = '<thinking>' + buffer;
                }
                
                // 2. 提取并移除思考内容
                const thinkingMatch = buffer.match(/<thinking>([\s\S]*?)<\/thinking>/);
                if (thinkingMatch) {
                    const thinkingContent = thinkingMatch[1];
                    console.log('[VideoCall CoT] Thinking:', thinkingContent);
                    // 移除思考标签及内容
                    buffer = buffer.replace(/<thinking>[\s\S]*?<\/thinking>/, "").trim();
                }
                
                // 3. 移除 [incipere] (如果有残留)
                buffer = buffer.replace(/\[incipere\]/g, "");
            }

            // 流结束后一次性回调
            onStreamUpdate(buffer);
            return buffer;
        }
    } catch (e) {
        console.error("Call API Error:", e);
        showToast("通话连接不稳定...");
        return null;
    }
}

async function generateCallSummary(chat, callContext) {
    let {url, key, model, provider} = db.apiSettings;
    if (!url || !key || !model) return null;
    if (url.endsWith('/')) url = url.slice(0, -1);

    // 获取世界书
    const worldBooksBefore = (chat.worldBookIds || []).map(id => db.worldBooks.find(wb => wb.id === id && wb.position === 'before')).filter(Boolean).map(wb => wb.content).join('\n');
    const worldBooksAfter = (chat.worldBookIds || []).map(id => db.worldBooks.find(wb => wb.id === id && wb.position === 'after')).filter(Boolean).map(wb => wb.content).join('\n');

    // 获取回忆日记（受全局开关控制）
    const favoritedJournals = getFavoritedJournalsForAi(chat)
        .map(j => `标题：${j.title}\n内容：${j.content}`)
        .join('\n\n---\n\n');

    let prompt = `请根据以下背景信息和通话记录，生成一段简短的聊天记录总结。\n\n`;

    prompt += `<char_settings>\n`;
    prompt += `角色名：${chat.realName}\n`;
    prompt += `角色设定：${chat.persona || "无"}\n`;
    if (worldBooksBefore) prompt += `${worldBooksBefore}\n`;
    if (worldBooksAfter) prompt += `${worldBooksAfter}\n`;
    prompt += `</char_settings>\n\n`;

    prompt += `<user_settings>\n`;
    prompt += `用户称呼：${chat.myName}\n`;
    prompt += `用户人设：${chat.myPersona || "无"}\n`;
    prompt += `</user_settings>\n\n`;

    if (favoritedJournals) {
        prompt += `<memoir>\n`;
        prompt += `【共同回忆】\n${favoritedJournals}\n`;
        prompt += `</memoir>\n\n`;
    }

    prompt += `通话记录：\n`;
    prompt += `${callContext.map(m => `${m.role === 'ai' ? chat.realName : chat.myName} (${m.type}): ${m.content}`).join('\n')}\n\n`;

    prompt += `要求：\n`;
    prompt += `1. 第三人称叙述。\n`;
    prompt += `2. **客观平实**：使用第三人称视角，客观陈述事实。**绝对禁止使用强烈的情绪词汇**（如“极度愤怒”、“痛彻心扉”、“欣喜若狂”等），保持冷静、克制的叙述风格。\n`;
    prompt += `3. **无升华**：不要进行价值升华、感悟或总结性评价，仅记录发生了什么。\n`;
    prompt += `4. 不要包含“通话记录如下”等废话，直接输出总结内容。\n`;

    const messages = [{role: 'user', content: prompt}];
    
    const requestBody = {
        model: model,
        messages: messages,
        stream: false
    };
    
    if (provider === 'gemini') {
         requestBody.contents = [{role: 'user', parts: [{text: prompt}]}];
         delete requestBody.messages;
    }

    const endpoint = (provider === 'gemini') ? `${url}/v1beta/models/${model}:generateContent?key=${getRandomValue(key)}` : `${url}/v1/chat/completions`;
    const headers = (provider === 'gemini') ? {'Content-Type': 'application/json'} : {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`
    };

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(requestBody)
        });
        const data = await response.json();
        let text = "";
        if (provider === 'gemini') {
            text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
        } else {
            text = data.choices[0].message.content;
        }
        return text.trim();
    } catch (e) {
        console.error("Summary API Error:", e);
        return null;
    }
}
