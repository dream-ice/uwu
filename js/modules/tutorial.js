// --- 教程与备份功能 (js/modules/tutorial.js) ---

function setupTutorialApp() {
    const tutorialContentArea = document.getElementById('tutorial-content-area');
    tutorialContentArea.addEventListener('click', (e) => {
        const header = e.target.closest('.tutorial-header');
        if (header) {
            header.parentElement.classList.toggle('open');
        }
    });
}

function renderUpdateLog() {
    const tutorialContent = document.getElementById('tutorial-content-area');
    if (!tutorialContent) return;

    const updateSection = document.createElement('div');
    updateSection.className = 'tutorial-item'; 

    let notesHtml = '';
    updateLog.forEach((log, index) => {
        notesHtml += `
            <div style="margin-bottom: 15px; ${index < updateLog.length - 1 ? 'padding-bottom: 10px; border-bottom: 1px solid #f0f0f0;' : ''}">
                <h4 style="font-size: 15px; color: #333; margin: 0 0 5px 0;">版本 ${log.version} (${log.date})</h4>
                <ul style="padding-left: 20px; margin: 0; list-style-type: '› ';">
                    ${log.notes.map(note => `<li style="margin-bottom: 5px; color: #666;">${note}</li>`).join('')}
                </ul>
            </div>
        `;
    });

    updateSection.innerHTML = `
        <div class="tutorial-header">更新日志</div>
        <div class="tutorial-content" style="padding-top: 15px;">
            ${notesHtml}
        </div>
    `;
    
    tutorialContent.appendChild(updateSection);
}

function showUpdateModal() {
    const modal = document.getElementById('update-log-modal');
    const contentEl = document.getElementById('update-log-modal-content');
    const closeBtn = document.getElementById('close-update-log-modal');

    const latestLog = updateLog[0];
    if (!latestLog) return;

    // 优化内容渲染
    let notesHtml = '<div style="text-align: left; max-height: 60vh; overflow-y: auto; padding-right: 5px;">';
    latestLog.notes.forEach(note => {
        // 处理加粗标记 **text** -> <b>text</b>
        let formattedNote = note.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');

        if (note.includes('————')) {
            // 分割线
            notesHtml += '<hr style="margin: 15px 0; border: 0; border-top: 1px dashed #ccc;">';
        } else if (/^\d+\./.test(note)) {
            // 标题行 (例如 "1.日记功能升级！")
            notesHtml += `<h4 style="margin: 15px 0 8px; color: #333; font-size: 15px; font-weight: 600;">${formattedNote}</h4>`;
        } else {
            // 普通内容行
            notesHtml += `<div style="margin-bottom: 6px; color: #555; font-size: 13px; line-height: 1.5; padding-left: 12px; position: relative;">
                <span style="position: absolute; left: 0; top: 0; color: #999;">•</span>${formattedNote}
            </div>`;
        }
    });
    notesHtml += '</div>';

    contentEl.innerHTML = `
        <h3 style="margin-top: 0; margin-bottom: 15px; text-align: center;">版本 ${latestLog.version} (${latestLog.date})</h3>
        ${notesHtml}
        <p style="font-size: 12px; color: #888; text-align: center; margin-top: 15px; border-top: 1px solid #eee; padding-top: 10px;">过往更新说明可在“教程”应用内查看。</p>
    `;

    modal.classList.add('visible');

    // 强制阅读倒计时
    const originalText = "我知道了";
    let timeLeft = 10;
    closeBtn.disabled = true;
    closeBtn.textContent = `请阅读 (${timeLeft}s)`;
    closeBtn.style.opacity = '0.6';
    closeBtn.style.cursor = 'not-allowed';

    const timer = setInterval(() => {
        timeLeft--;
        if (timeLeft > 0) {
            closeBtn.textContent = `请阅读 (${timeLeft}s)`;
        } else {
            clearInterval(timer);
            closeBtn.disabled = false;
            closeBtn.textContent = originalText;
            closeBtn.style.opacity = '1';
            closeBtn.style.cursor = 'pointer';
        }
    }, 1000);

    closeBtn.onclick = () => {
        modal.classList.remove('visible');
        localStorage.setItem('lastSeenVersion', appVersion);
    };
}

function checkForUpdates() {
    const lastSeenVersion = localStorage.getItem('lastSeenVersion');
    if (lastSeenVersion !== appVersion) {
        // 仅当当前版本为 1.8.0 时，才执行引导重置
        if (appVersion === '1.8.0') {
            Object.keys(localStorage).forEach(key => {
                if (key.startsWith('guide_')) {
                    localStorage.removeItem(key);
                }
            });
        }

        setTimeout(showUpdateModal, 500);
    }
}

// --- Guide System (分步引导) ---
const GuideSystem = {
    check: function(guideId, nextCallback) {
        // 检查是否已显示过
        if (localStorage.getItem(guideId) === 'true') return;

        // 根据 ID 定义引导内容
        let config = null;
        switch (guideId) {
            case 'guide_search_entry':
                config = {
                    target: '.search-bar-decoration',
                    text: '新增搜索功能！支持按角色、群聊筛选，快速查找历史记录。',
                    position: 'bottom'
                };
                break;
            case 'guide_char_gallery':
                config = {
                    target: '#char-gallery-manage-btn',
                    text: '新增 TA 相册！在这里管理角色的专属照片，在聊天设置里开启此开关后，聊天时角色可直接发送上传的图片。',
                    position: 'top'
                };
                break;
            case 'guide_group_summary':
                config = {
                    target: '#memory-journal-btn',
                    text: '群聊记录太多？点击这里一键生成智能总结，自动关联当前群聊世界书，内置提示词。',
                    position: 'top'
                };
                break;
            case 'guide_group_notice':
                config = {
                    target: '#setting-group-notice',
                    text: '新增群公告！设置剧情背景或重要通知，让所有成员知晓。',
                    position: 'bottom',
                    parent: '.kkt-item' // 高亮父容器
                };
                break;
            case 'guide_group_gossip':
                config = {
                    target: '#setting-group-allow-gossip',
                    text: '开启群内私聊！双击群聊标题可查看，群成员之间可以悄悄互动，八卦吐槽更真实。',
                    position: 'bottom',
                    parent: '.kkt-item'
                };
                break;
        }

        if (config) {
            // 稍微延迟以确保 DOM 渲染完成
            setTimeout(() => {
                const targetEl = document.querySelector(config.target);
                if (targetEl && targetEl.offsetParent !== null) { // 确保元素可见
                    this.show(targetEl, config, guideId, nextCallback);
                }
            }, 500);
        }
    },

    show: function(targetEl, config, guideId, nextCallback) {
        // 1. 先滚动到可见区域
        const highlightEl = config.parent ? targetEl.closest(config.parent) : targetEl;
        
        // 特殊处理 Swiper 容器内的元素，避免触发页面整体水平滚动
        const swiperWrapper = highlightEl.closest('.function-swiper-wrapper');
        if (swiperWrapper) {
            const slide = highlightEl.closest('.function-slide');
            if (slide) {
                // 滚动到对应的 slide，使用 inline: 'start' 确保对齐且不溢出
                slide.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' });
            } else {
                highlightEl.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
            }
        } else {
            highlightEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }

        // 强制重置页面水平滚动，防止露出侧边栏
        const resetScroll = () => {
            document.documentElement.scrollLeft = 0;
            document.body.scrollLeft = 0;
        };
        // 在滚动开始和结束时多次尝试重置
        setTimeout(resetScroll, 50);
        setTimeout(resetScroll, 200);
        setTimeout(resetScroll, 600);

        // 2. 延迟显示引导（等待滚动完成）
        setTimeout(() => {
            // 再次重置滚动位置，确保万无一失
            resetScroll();

            // 移除现有的引导
            this.cleanup();

            // 创建遮罩
            const overlay = document.createElement('div');
            overlay.className = 'guide-overlay visible';
            document.body.appendChild(overlay);

            // 重新计算高亮位置（滚动后）
            const rect = highlightEl.getBoundingClientRect();
            
            // 创建高亮框
            const highlightBox = document.createElement('div');
            highlightBox.className = 'guide-highlight-box';
            // 强制使用 fixed 定位，避免滚动容器导致的坐标偏移问题
            highlightBox.style.position = 'fixed';
            highlightBox.style.top = `${rect.top}px`;
            highlightBox.style.left = `${rect.left}px`;
            highlightBox.style.width = `${rect.width}px`;
            highlightBox.style.height = `${rect.height}px`;
            document.body.appendChild(highlightBox);

            // 创建提示气泡
            const tooltip = document.createElement('div');
            tooltip.className = `guide-tooltip ${config.position || 'bottom'} visible`;
            // 气泡也使用 fixed 定位
            tooltip.style.position = 'fixed';
            
            tooltip.innerHTML = `
                <div class="guide-content">${config.text}</div>
                <div class="guide-footer">
                    <button class="guide-btn guide-btn-primary">我知道了</button>
                </div>
            `;
            document.body.appendChild(tooltip);

            // 计算气泡位置 (需要先添加到 DOM 获取尺寸)
            const tooltipRect = tooltip.getBoundingClientRect();
            const tooltipWidth = tooltipRect.width;
            const screenWidth = window.innerWidth;
            const margin = 10; // 屏幕边缘间距

            let tooltipTop, tooltipLeft;
            
            // 初始水平居中对齐目标
            let idealLeft = rect.left + rect.width / 2 - tooltipWidth / 2;

            // 边界检测与调整
            if (idealLeft < margin) {
                tooltipLeft = margin;
            } else if (idealLeft + tooltipWidth > screenWidth - margin) {
                tooltipLeft = screenWidth - tooltipWidth - margin;
            } else {
                tooltipLeft = idealLeft;
            }

            // 计算箭头偏移量 (相对于 tooltip 左边缘)
            const targetCenterX = rect.left + rect.width / 2;
            let arrowRelX = targetCenterX - tooltipLeft;
            
            // 限制箭头在 tooltip 内部 (留出圆角空间)
            const arrowMargin = 20;
            if (arrowRelX < arrowMargin) arrowRelX = arrowMargin;
            if (arrowRelX > tooltipWidth - arrowMargin) arrowRelX = tooltipWidth - arrowMargin;

            // 设置箭头位置变量
            tooltip.style.setProperty('--arrow-left', `${arrowRelX}px`);

            // 垂直位置
            if (config.position === 'top') {
                tooltipTop = rect.top - 10; 
                tooltip.style.transform = 'translateY(-100%) translateY(-10px)';
            } else {
                tooltipTop = rect.bottom + 10;
                tooltip.style.transform = 'translateY(10px)';
            }
            
            tooltip.style.top = `${tooltipTop}px`;
            tooltip.style.left = `${tooltipLeft}px`;

            // 绑定事件
            const closeGuide = () => {
                this.cleanup();
                localStorage.setItem(guideId, 'true');
                if (nextCallback) nextCallback();
            };

            overlay.addEventListener('click', closeGuide);
            tooltip.querySelector('.guide-btn-primary').addEventListener('click', closeGuide);
        }, 500); // 等待 500ms 确保滚动完成
    },

    cleanup: function() {
        const overlay = document.querySelector('.guide-overlay');
        const highlight = document.querySelector('.guide-highlight-box');
        const tooltip = document.querySelector('.guide-tooltip');
        if (overlay) overlay.remove();
        if (highlight) highlight.remove();
        if (tooltip) tooltip.remove();
    }
};
window.GuideSystem = GuideSystem;

let loadingBtn = false

function renderTutorialContent() {
    const tutorialContentArea = document.getElementById('tutorial-content-area');
    const tutorials = [
        {title: '写在前面', imageUrls: ['https://i.postimg.cc/3RJfvgzq/xie-zai-qian-mian(1).jpg']},
        {
            title: '软件介绍',
            imageUrls: ['https://i.postimg.cc/VvsJRh6q/IMG-20250713-162647.jpg', 'https://i.postimg.cc/8P5FfxxD/IMG-20250713-162702.jpg', 'https://i.postimg.cc/3r94R3Sn/IMG-20250713-162712.jpg']
        },
        {
            title: '404',
            imageUrls: ['https://i.postimg.cc/x8scFPJW/IMG-20250713-162756.jpg', 'https://i.postimg.cc/pX6mfqtj/IMG-20250713-162809.jpg', 'https://i.postimg.cc/YScjV00q/IMG-20250713-162819.jpg', 'https://i.postimg.cc/13VfJw9j/IMG-20250713-162828.jpg']
        },
        {title: '404-群聊', imageUrls: ['https://i.postimg.cc/X7LSmRTJ/404.jpg']}
    ];
    tutorialContentArea.innerHTML = '';
    renderUpdateLog();
    tutorials.forEach(tutorial => {
        const item = document.createElement('div');
        item.className = 'tutorial-item';
        const imagesHtml = tutorial.imageUrls.map(url => `<img src="${url}" alt="${tutorial.title}教程图片">`).join('');
        item.innerHTML = `<div class="tutorial-header">${tutorial.title}</div><div class="tutorial-content">${imagesHtml}</div>`;
        tutorialContentArea.appendChild(item);
    });

    const backupDataBtn = document.createElement('button');
    backupDataBtn.className = 'btn btn-primary';
    backupDataBtn.textContent = '备份数据';
    backupDataBtn.disabled = loadingBtn

    backupDataBtn.addEventListener('click', async () => {
        if(loadingBtn){
            return
        }
        loadingBtn = true
        try {
            showToast('正在准备导出数据...');

            const fullBackupData = await createFullBackupData();

            const jsonString = JSON.stringify(fullBackupData);
            const dataBlob = new Blob([jsonString]);

            const compressionStream = new CompressionStream('gzip');
            const compressedStream = dataBlob.stream().pipeThrough(compressionStream);
            const compressedBlob = await new Response(compressedStream, { headers: { 'Content-Type': 'application/octet-stream' } }).blob();

            const url = URL.createObjectURL(compressedBlob);
            const a = document.createElement('a');
            const now = new Date();
            const date = now.toISOString().slice(0, 10);
            const time = now.toTimeString().slice(0, 8).replace(/:/g, '');
            a.href = url;
            a.download = `章鱼喷墨_备份数据_${date}_${time}.ee`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            loadingBtn = false
            showToast('聊天记录导出成功');
        }catch (e){
            loadingBtn = false
            showToast(`导出失败, 发生错误: ${e.message}`);
            console.error('导出错误详情:', e);
        }
    });
    const importDataBtn = document.createElement('label');
    importDataBtn.className = 'btn btn-neutral';
    importDataBtn.textContent = '导入数据';
    importDataBtn.style.marginTop = '15px'
    importDataBtn.style.display = 'block'
    importDataBtn.disabled = loadingBtn;
    importDataBtn.setAttribute('for', 'import-data-input')
    document.querySelector('#import-data-input').addEventListener('change', async (event) => {
        const file = event.target.files[0];
        if (!file) return;

        if(confirm('此操作将覆盖当前所有聊天记录和设置。此操作不可撤销。确定要继续吗？')){
            try {
                showToast('正在导入数据，请稍候...');

                const decompressionStream = new DecompressionStream('gzip');
                const decompressedStream = file.stream().pipeThrough(decompressionStream);
                const jsonString = await new Response(decompressedStream).text();

                let data = JSON.parse(jsonString);

                const importResult = await importBackupData(data);

                if (importResult.success) {
                    showToast(`数据导入成功！${importResult.message} 应用即将刷新。`);
                    setTimeout(() => {
                        window.location.reload();
                    }, 1500);
                } else {
                    showToast(`导入失败: ${importResult.error}`);
                }
            } catch (error) {
                console.error("导入失败:", error);
                showToast(`解压或解析文件时发生错误: ${error.message}`);
            } finally {
                event.target.value = null;
            }
        }else {
            event.target.value = null;
        }

    })

    tutorialContentArea.appendChild(backupDataBtn);
    tutorialContentArea.appendChild(importDataBtn);

    // GitHub Backup UI
    const githubSection = document.createElement('div');
    const iconEyeOpen = `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
    const iconEyeClosed = `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;

    githubSection.innerHTML = `
        <div style="font-size:0.89rem; color:#999; margin:20px 0 8px;">云端备份 (GitHub)</div>
        <div class="btn-white" style="display:block; cursor:default; background:#fff; border:1px solid #e0e0e0; border-radius:8px; padding:12px;">
            <div id="gh-collapse-header" style="display:flex; justify-content:space-between; align-items:center; cursor:pointer; padding-bottom:5px;">
                <div style="display:flex; align-items:center;">
                    <span style="color:#333; font-weight:500;">🔧 配置参数</span>
                    <div id="gh-help-btn" style="margin-left:8px; display:flex; align-items:center; padding:2px; cursor:pointer;">
                        <svg style="width:16px; height:16px; color:#1890ff;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
                    </div>
                </div>
                <svg class="toggle-icon" style="width:14px; height:14px; color:#999; transition:transform 0.3s;" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></polyline></svg>
            </div>

            <div id="gh-config-area" style="display:none; margin-top:10px; padding-top:10px; border-top:1px dashed #eee;">
                <div style="margin-bottom:10px;">
                    <div style="font-size:0.81rem; color:#666; margin-bottom:5px;">GitHub Token</div>
                    <div style="position:relative;">
                        <input type="password" id="gh-token-input" placeholder="ghp_xxxx..." style="width:100%; border:1px solid #eee; padding:8px; padding-right:35px; border-radius:4px; font-size:0.89rem;">
                        <div id="gh-eye-btn" style="position:absolute; right:10px; top:50%; transform:translateY(-50%); color:#999; cursor:pointer; display:flex;">
                            ${iconEyeClosed}
                        </div>
                    </div>
                </div>
                <div style="margin-bottom:10px;">
                    <div style="font-size:0.81rem; color:#666; margin-bottom:5px;">仓库路径 (用户名/仓库名)</div>
                    <input type="text" id="gh-repo-input" placeholder="username/repo" style="width:100%; border:1px solid #eee; padding:8px; border-radius:4px; font-size:0.89rem;">
                </div>
                <div style="margin-bottom:10px;">
                    <div style="font-size:0.81rem; color:#666; margin-bottom:5px;">备份文件名 (可选，填则覆盖)</div>
                    <input type="text" id="gh-filename-input" placeholder="例如: my_backup.ee" style="width:100%; border:1px solid #eee; padding:8px; border-radius:4px; font-size:0.89rem;">
                </div>
            </div>

            <div style="display:flex; justify-content:space-between; align-items:center; margin-top:10px; border-top:1px solid #f5f5f5; padding-top:10px;">
                <span>自动备份开关</span>
                <label class="switch" style="position:relative; display:inline-block; width:40px; height:24px;">
                    <input type="checkbox" id="gh-auto-switch" style="opacity:0; width:0; height:0;">
                    <span style="position:absolute; cursor:pointer; top:0; left:0; right:0; bottom:0; background-color:#ccc; transition:.4s; border-radius:24px;" id="gh-switch-slider"></span>
                    <style>
                        #gh-auto-switch:checked + #gh-switch-slider { background-color: #333; }
                        #gh-switch-slider:before { position:absolute; content:""; height:16px; width:16px; left:4px; bottom:4px; background-color:white; transition:.4s; border-radius:50%; }
                        #gh-auto-switch:checked + #gh-switch-slider:before { transform: translateX(16px); }
                    </style>
                </label>
            </div>

            <div id="gh-interval-setting" style="display:none; justify-content:space-between; align-items:center; margin-top:10px;">
                <span style="font-size:0.89rem; color:#666;">备份频率</span>
                <select id="gh-interval-select" style="border:1px solid #eee; padding:5px; border-radius:4px; font-size:0.89rem; background:#fff;">
                    <option value="24">每 24 小时</option>
                    <option value="36">每 36 小时</option>
                    <option value="48">每 48 小时</option>
                </select>
            </div>

            <div style="margin-top:15px; display:flex; gap:10px;">
                <div id="gh-backup-btn" style="flex:1; background:#333; color:#fff; text-align:center; padding:8px; border-radius:4px; font-size:0.89rem; cursor:pointer;">立即备份</div>
                <div id="gh-restore-btn" style="flex:1; background:#1890ff; color:#fff; text-align:center; padding:8px; border-radius:4px; font-size:0.89rem; cursor:pointer;">恢复最新</div>
                <div id="gh-check-btn" style="flex:1; background:#f5f5f5; color:#666; text-align:center; padding:8px; border-radius:4px; font-size:0.89rem; cursor:pointer;">检查状态</div>
            </div>
            
            <div id="gh-status-msg" style="margin-top:10px; font-size:0.74rem; color:#999;"></div>
        </div>
    `;
    
    tutorialContentArea.appendChild(githubSection);

    const existingOverlay = document.getElementById('gh-help-overlay');
    if (existingOverlay) existingOverlay.remove();

    const helpOverlay = document.createElement('div');
    helpOverlay.id = 'gh-help-overlay';
    helpOverlay.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 9999; display: none; align-items: center; justify-content: center;';
    
    helpOverlay.onclick = function(e) { 
        if(e.target === this) this.style.display = 'none'; 
    };
    
    helpOverlay.innerHTML = `
        <div class="modal-window" style="width: 85%; max-height: 80vh; overflow-y: auto; background: #fff; padding: 20px; border-radius: 12px; box-shadow: 0 5px 20px rgba(0,0,0,0.2);">
            <h3 style="margin-top:0; margin-bottom:15px; text-align:center; font-size:1.1rem; color: var(--primary-color);">GitHub 配置指南</h3>
            
            <h4 style="margin:10px 0 5px; color:#333;">1. 获取 Token</h4>
            <ol style="padding-left:20px; font-size:0.89rem; color:#555; line-height:1.6;">
                <li>登录 GitHub，点击头像 → <strong>Settings</strong></li>
                <li>左侧菜单到底 → <strong>Developer settings</strong></li>
                <li><strong>Personal access tokens</strong> → <strong>Tokens (classic)</strong></li>
                <li>Generate new token (classic)</li>
                <li>Expiration 选 <strong>No expiration</strong></li>
                <li><strong style="color:#d32f2f;">Scopes 必须勾选 repo (包含所有子项)</strong></li>
                <li>点击 Generate，复制 ghp_ 开头的字符。<br><strong style="color:#d32f2f;">一定要现在复制并保存好！一旦刷新页面，你就再也看不到它了。</strong></li>
            </ol>

            <h4 style="margin:15px 0 5px; color:#333;">2. 创建仓库</h4>
            <ol style="padding-left:20px; font-size:0.89rem; color:#555; line-height:1.6;">
                <li>右上角 + 号 → <strong>New repository</strong></li>
                <li>Repository name 填个名字</li>
                <li>建议选 <strong>Private</strong> (私有)</li>
                <li>点击 Create repository</li>
            </ol>

            <h4 style="margin:15px 0 5px; color:#333;">3. 填写示例</h4>
            <ul style="padding-left:20px; font-size:0.89rem; color:#555; line-height:1.6;">
                <li>Token: <code>ghp_xxxxxxxxxxxx...</code></li>
                <li>仓库路径: <code>用户名/仓库名</code></li>
            </ul>

            <div style="margin-top:20px; text-align: center;">
                <button class="btn btn-primary" onclick="document.getElementById('gh-help-overlay').style.display='none'">我学会了</button>
            </div>
        </div>
    `;
    document.body.appendChild(helpOverlay);

    document.getElementById('gh-collapse-header').addEventListener('click', function() {
        const area = document.getElementById('gh-config-area');
        const icon = this.querySelector('.toggle-icon');
        if (area.style.display === 'none') {
            area.style.display = 'block';
            icon.style.transform = 'rotate(180deg)';
        } else {
            area.style.display = 'none';
            icon.style.transform = 'rotate(0deg)';
        }
    });

    document.getElementById('gh-help-btn').addEventListener('click', function(e) {
        e.stopPropagation(); 
        document.getElementById('gh-help-overlay').style.display = 'flex';
    });

    document.getElementById('gh-eye-btn').addEventListener('click', function() {
        const input = document.getElementById('gh-token-input');
        if (input.type === 'password') {
            input.type = 'text';
            this.innerHTML = iconEyeOpen;
        } else {
            input.type = 'password';
            this.innerHTML = iconEyeClosed;
        }
    });

    const saveHandler = () => { if(window.GitHubMgr) window.GitHubMgr.saveConfig(); };
    document.getElementById('gh-token-input').addEventListener('change', saveHandler);
    document.getElementById('gh-repo-input').addEventListener('change', saveHandler);
    document.getElementById('gh-filename-input').addEventListener('change', saveHandler);
    document.getElementById('gh-auto-switch').addEventListener('change', saveHandler);
    document.getElementById('gh-interval-select').addEventListener('change', saveHandler);

    document.getElementById('gh-backup-btn').addEventListener('click', () => window.GitHubMgr.testUpload());
    document.getElementById('gh-restore-btn').addEventListener('click', () => window.GitHubMgr.restoreLatest());
    document.getElementById('gh-check-btn').addEventListener('click', () => window.GitHubMgr.checkStatus());

    if(window.GitHubMgr) {
        window.GitHubMgr.init();
    }
}

// 创建完整的备份数据
async function createFullBackupData() {
    const backupData = JSON.parse(JSON.stringify(db));
    backupData._exportVersion = '3.0'; 
    backupData._exportTimestamp = Date.now();
    return backupData;
}

// 导入备份数据
async function importBackupData(data) {
    const startTime = Date.now();
    try {
        await Promise.all([
            dexieDB.characters.clear(),
            dexieDB.groups.clear(),
            dexieDB.worldBooks.clear(),
            dexieDB.myStickers.clear(),
            dexieDB.globalSettings.clear()
        ]);
        showToast('正在清空旧数据...');

        let convertedData = data;

        if (data._exportVersion !== '3.0') {
            showToast('检测到旧版备份文件，正在转换格式...');
            
            const reassembleHistory = (chat, backupData) => {
                if (!chat.history || !Array.isArray(chat.history) || chat.history.length === 0) {
                    return [];
                }
                if (typeof chat.history[0] === 'object' && chat.history[0] !== null) {
                    return chat.history;
                }
                if (backupData.__chunks__ && typeof chat.history[0] === 'string') {
                    let fullHistory = [];
                    chat.history.forEach(key => {
                        if (backupData.__chunks__[key]) {
                            try {
                                const chunk = JSON.parse(backupData.__chunks__[key]);
                                fullHistory = fullHistory.concat(chunk);
                            } catch (e) {
                                console.error(`Failed to parse history chunk ${key}`, e);
                            }
                        }
                    });
                    return fullHistory;
                }
                return []; 
            };

            const newData = { ...data };

            if (newData.characters) {
                newData.characters = newData.characters.map(char => ({
                    ...char,
                    history: reassembleHistory(char, data)
                }));
            }
            if (newData.groups) {
                newData.groups = newData.groups.map(group => ({
                    ...group,
                    history: reassembleHistory(group, data)
                }));
            }
            
            convertedData = newData;
        }

        Object.keys(db).forEach(key => {
            if (convertedData[key] !== undefined) {
                db[key] = convertedData[key];
            }
        });
        
        if (!db.pomodoroTasks) db.pomodoroTasks = [];
        if (!db.pomodoroSettings) db.pomodoroSettings = { boundCharId: null, userPersona: '', focusBackground: '', taskCardBackground: '', encouragementMinutes: 25, pokeLimit: 5, globalWorldBookIds: [] };
        if (!db.insWidgetSettings) db.insWidgetSettings = { avatar1: 'https://i.postimg.cc/Y96LPskq/o-o-2.jpg', bubble1: 'love u.', avatar2: 'https://i.postimg.cc/GtbTnxhP/o-o-1.jpg', bubble2: 'miss u.' };
        if (!db.homeWidgetSettings) db.homeWidgetSettings = JSON.parse(JSON.stringify(defaultWidgetSettings));


        showToast('正在写入新数据...');
        await saveData(db);

        const duration = Date.now() - startTime;
        const message = `导入完成 (耗时${duration}ms)`;
        
        return { success: true, message: message };

    } catch (error) {
        console.error('导入数据失败:', error);
        return {
            success: false,
            error: error.message,
            duration: Date.now() - startTime
        };
    }
}

// GitHub Manager
const GitHubMgr = {
    config: { token: '', repo: '', auto: false, interval: 48, lastTime: 0, fileName: '' },
    
    init: () => {
        const confStr = localStorage.getItem('gh_config');
        if(confStr) GitHubMgr.config = JSON.parse(confStr);
        
        const tokenInput = document.getElementById('gh-token-input');
        const repoInput = document.getElementById('gh-repo-input');
        const fileNameInput = document.getElementById('gh-filename-input');
        const autoSwitch = document.getElementById('gh-auto-switch');
        
        if(tokenInput) tokenInput.value = GitHubMgr.config.token || '';
        if(repoInput) repoInput.value = GitHubMgr.config.repo || '';
        if(fileNameInput) fileNameInput.value = GitHubMgr.config.fileName || '';
        
        if(autoSwitch) {
            autoSwitch.checked = GitHubMgr.config.auto || false;
            document.getElementById('gh-interval-setting').style.display = autoSwitch.checked ? 'flex' : 'none';
        }
        if(document.getElementById('gh-interval-select')) {
            document.getElementById('gh-interval-select').value = GitHubMgr.config.interval || 48;
        }
        
        if(GitHubMgr.config.auto) GitHubMgr.checkAndBackup();
        GitHubMgr.updateStatusText();
    },
    
    saveConfig: () => {
        let token = document.getElementById('gh-token-input').value.trim();
        // 自动清理 Token：移除前缀和空格
        token = token.replace(/^(Bearer|token)\s+/i, '').replace(/\s+/g, '');

        const repo = document.getElementById('gh-repo-input').value.trim();
        const fileName = document.getElementById('gh-filename-input').value.trim();
        const auto = document.getElementById('gh-auto-switch').checked;
        const interval = parseInt(document.getElementById('gh-interval-select').value);
        
        GitHubMgr.config.token = token;
        GitHubMgr.config.repo = repo;
        GitHubMgr.config.fileName = fileName;
        GitHubMgr.config.auto = auto;
        GitHubMgr.config.interval = interval;
        
        document.getElementById('gh-interval-setting').style.display = auto ? 'flex' : 'none';
        
        localStorage.setItem('gh_config', JSON.stringify(GitHubMgr.config));
        GitHubMgr.updateStatusText();
        
        if(auto) GitHubMgr.checkAndBackup();
    },
    
    updateStatusText: () => {
        const el = document.getElementById('gh-status-msg');
        if(!el) return;
        if(!GitHubMgr.config.lastTime) el.innerText = '从未备份过';
        else {
            const date = new Date(GitHubMgr.config.lastTime);
            const nextTime = new Date(GitHubMgr.config.lastTime + (GitHubMgr.config.interval || 48) * 3600000);
            el.innerText = `上次: ${date.toLocaleString()} (下次约: ${nextTime.toLocaleString()})`;
        }
    },
    
    checkAndBackup: async () => {
        if(!GitHubMgr.config.token || !GitHubMgr.config.repo || !GitHubMgr.config.auto) return;
        const now = Date.now();
        const interval = GitHubMgr.config.interval || 48;
        const hours = (now - (GitHubMgr.config.lastTime || 0)) / (1000 * 60 * 60);
        
        if(hours >= interval) {
            console.log(`距离上次备份已过 ${hours.toFixed(1)} 小时，触发自动备份...`);
            
            const toast = document.createElement('div');
            toast.style.cssText = 'position:fixed; top:10px; left:50%; transform:translateX(-50%); background:rgba(0,0,0,0.7); color:#fff; padding:8px 15px; border-radius:20px; font-size:12px; z-index:9999; pointer-events:none; transition:opacity 0.5s;';
            toast.innerText = '正在后台准备自动备份...';
            document.body.appendChild(toast);
            
            try {
                await GitHubMgr.performUpload((msg) => { toast.innerText = '自动备份: ' + msg; });
                toast.innerText = '自动备份成功！';
                setTimeout(() => toast.remove(), 3000);
            } catch(e) {
                console.error('自动备份失败', e);
                toast.innerText = '自动备份失败: ' + e.message;
                setTimeout(() => toast.remove(), 5000);
            }
        }
    },
    
    testUpload: async () => {
        GitHubMgr.saveConfig(); // 强制保存当前输入框的值
        if(!GitHubMgr.config.token || !GitHubMgr.config.repo) return alert('请先填写 Token 和 仓库路径');
        showToast('开始备份...');
        const btn = event.target;
        const originalText = btn.innerText;
        btn.innerText = '备份中...';
        btn.style.pointerEvents = 'none';
        
        try {
            await GitHubMgr.performUpload((msg) => { showToast(msg); });
            showToast('上传成功！');
        } catch(e) {
            showToast('上传失败: ' + e.message);
        } finally {
            btn.innerText = originalText;
            btn.style.pointerEvents = 'auto';
        }
    },
    
    performUpload: async (onProgress) => {
        // 1. 预检权限
        onProgress('正在检查权限...');
        const checkUrl = `https://api.github.com/repos/${GitHubMgr.config.repo}`;
        const checkRes = await fetch(checkUrl, {
            headers: { 'Authorization': `token ${GitHubMgr.config.token}` }
        });
        
        if (!checkRes.ok) {
             if (checkRes.status === 401) throw new Error('Token 无效或过期 (401)');
             if (checkRes.status === 404) throw new Error('仓库不存在或 Token 无权访问 (404)');
             throw new Error(`权限检查失败: ${checkRes.status}`);
        }
        
        const repoInfo = await checkRes.json();
        // 检查 push 权限
        if (repoInfo.permissions && repoInfo.permissions.push === false) {
            throw new Error('Token 缺少写入权限 (push)，请重新生成 Token 并勾选 repo 权限');
        }

        onProgress('正在打包数据...');
        const backupData = await createFullBackupData();
        const jsonString = JSON.stringify(backupData);
        
        onProgress('正在压缩...');
        const dataBlob = new Blob([jsonString]);
        const compressionStream = new CompressionStream('gzip');
        const compressedStream = dataBlob.stream().pipeThrough(compressionStream);
        const compressedBlob = await new Response(compressedStream, { headers: { 'Content-Type': 'application/octet-stream' } }).blob();
        
        onProgress('正在编码...');
        const base64Content = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                const res = reader.result;
                let base64 = res.split(',')[1]; 
                // 移除可能存在的换行符，防止上传失败
                base64 = base64.replace(/\s/g, '');
                resolve(base64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(compressedBlob);
        });

        onProgress('正在上传至 GitHub...');
        let path = '';
        let sha = null;
        const customName = GitHubMgr.config.fileName;
        
        if (customName && customName.trim()) {
            path = customName.trim();
            if (!path.endsWith('.ee')) path += '.ee';
            
            try {
                const checkUrl = `https://api.github.com/repos/${GitHubMgr.config.repo}/contents/${encodeURIComponent(path)}`;
                const checkRes = await fetch(checkUrl, {
                    headers: { 'Authorization': `token ${GitHubMgr.config.token}` }
                });
                if (checkRes.ok) {
                    const fileData = await checkRes.json();
                    sha = fileData.sha;
                }
            } catch(e) {
                console.log('File does not exist or error checking:', e);
            }
        } else {
            const dateStr = new Date().toISOString().slice(0, 10);
            path = `AutoBackup_${dateStr}_${Date.now()}.ee`; 
        }
        
        const url = `https://api.github.com/repos/${GitHubMgr.config.repo}/contents/${encodeURIComponent(path)}`;
        
        const body = {
            message: `Auto backup`,
            content: base64Content
        };
        if (sha) body.sha = sha; 

        const response = await fetch(url, {
            method: 'PUT',
            headers: {
                'Authorization': `token ${GitHubMgr.config.token}`,
                'Content-Type': 'application/json',
                'Accept': 'application/vnd.github.v3+json'
            },
            body: JSON.stringify(body)
        });

        if(!response.ok) {
            const errJson = await response.json();
            throw new Error(errJson.message || 'GitHub API Error');
        }

        GitHubMgr.config.lastTime = Date.now();
        localStorage.setItem('gh_config', JSON.stringify(GitHubMgr.config));
        GitHubMgr.updateStatusText();
    },
    
    checkStatus: async () => {
        if(!GitHubMgr.config.token || !GitHubMgr.config.repo) return showToast('未配置');
        const url = `https://api.github.com/repos/${GitHubMgr.config.repo}`;
        try {
            const res = await fetch(url, { headers: { 'Authorization': `token ${GitHubMgr.config.token}` } });
            if(res.ok) {
                const data = await res.json();
                alert(`连接成功！\n仓库: ${data.full_name}\n私有: ${data.private}\n说明: 配置有效`);
            } else {
                alert('连接失败，请检查 Token 或 仓库路径');
            }
        } catch(e) { alert('网络错误: ' + e.message); }
    },
    
    restoreLatest: async () => {
        if(!GitHubMgr.config.token || !GitHubMgr.config.repo) return alert('请先在配置中填写 Token 和 仓库路径');
        if(!confirm('⚠️ 警告：这将下载最新的自动备份并覆盖当前所有数据！\n此操作不可撤销！\n\n确定要继续吗？')) return;

        showToast('正在连接 GitHub...');
        const btn = event.target;
        const originalText = btn.innerText;
        btn.innerText = '恢复中...';
        btn.style.pointerEvents = 'none';

        try {
            const customName = GitHubMgr.config.fileName;
            let targetFile = null;

            if (customName && customName.trim()) {
                let path = customName.trim();
                if (!path.endsWith('.ee')) path += '.ee';
                targetFile = { name: path };
            } else {
                const url = `https://api.github.com/repos/${GitHubMgr.config.repo}/contents/`;
                const res = await fetch(url, { headers: { 'Authorization': `token ${GitHubMgr.config.token}` } });
                
                if(!res.ok) {
                    if(res.status === 404) throw new Error('仓库不存在或路径错误');
                    if(res.status === 401) throw new Error('Token 无效或无权限');
                    throw new Error('获取列表失败: ' + res.status);
                }
                
                const files = await res.json();
                
                const backups = files.filter(f => f.name.startsWith('AutoBackup_') && f.name.endsWith('.ee'));
                if(backups.length === 0) throw new Error('仓库中没有找到任何 .ee 备份文件');

                backups.sort((a, b) => {
                    const getTs = (name) => {
                        const match = name.match(/_(\d+)\.ee$/);
                        return match ? parseInt(match[1]) : 0;
                    };
                    return getTs(b.name) - getTs(a.name);
                });

                targetFile = backups[0];
            }

            if (!targetFile) throw new Error('未找到可恢复的备份文件');

            showToast('正在下载: ' + targetFile.name);

            const dlUrl = `https://api.github.com/repos/${GitHubMgr.config.repo}/contents/${encodeURIComponent(targetFile.name)}`;
            const dlRes = await fetch(dlUrl, {
                headers: {
                    'Authorization': `token ${GitHubMgr.config.token}`,
                    'Accept': 'application/vnd.github.v3.raw'
                }
            });

            if(!dlRes.ok) throw new Error('下载文件失败: ' + dlRes.status);
            
            showToast('下载完成，正在解压...');
            const blob = await dlRes.blob();
            
            const decompressionStream = new DecompressionStream('gzip');
            const decompressedStream = blob.stream().pipeThrough(decompressionStream);
            const jsonString = await new Response(decompressedStream).text();
            
            const data = JSON.parse(jsonString);
            
            showToast('解压完成，开始导入...');
            const importResult = await importBackupData(data);

            if (importResult.success) {
                showToast(`恢复成功！${importResult.message} 应用即将刷新。`);
                setTimeout(() => {
                    window.location.reload();
                }, 1500);
            } else {
                throw new Error(importResult.error);
            }

        } catch(e) {
            console.error(e);
            alert('恢复失败: ' + e.message);
            btn.innerText = originalText;
            btn.style.pointerEvents = 'auto';
        }
    }
};
window.GitHubMgr = GitHubMgr;
