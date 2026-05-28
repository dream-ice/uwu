// --- 存储分析 (js/modules/storage.js) ---

function setupStorageAnalysisScreen() {
    const screen = document.getElementById('storage-analysis-screen');
    const chartContainer = document.getElementById('storage-chart-container');
    const detailsList = document.getElementById('storage-details-list');
    let myChart = null;

    const colorPalette = ['#ff80ab', '#90caf9', '#a5d6a7', '#fff59d', '#b39ddb', '#ffcc80'];

    const categoryNames = {
        messages: '聊天记录',
        charactersAndGroups: '角色与群组',
        worldAndForum: '世界书与论坛',
        personalization: '个性化设置',
        apiAndCore: '核心与API',
        other: '其他数据'
    };

    function formatBytes(bytes, decimals = 2) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    }

    function renderStorageChart(info, colors) {
        if (!myChart) {
            myChart = echarts.init(chartContainer);
        }

        const chartData = Object.entries(info.categorizedSizes)
            .map(([key, value]) => ({
                name: categoryNames[key] || key,
                value: value
            }))
            .filter(item => item.value > 0);

        const option = {
            color: colors,
            tooltip: {
                trigger: 'item',
                formatter: '{a} <br/>{b}: {c} ({d}%)'
            },
            legend: {
                show: false 
            },
            series: [
                {
                    name: '存储占比',
                    type: 'pie',
                    radius: ['50%', '70%'],
                    avoidLabelOverlap: false,
                    label: {
                        show: false,
                        position: 'center'
                    },
                    emphasis: {
                        label: {
                            show: true,
                            fontSize: '20',
                            fontWeight: 'bold'
                        }
                    },
                    labelLine: {
                        show: false
                    },
                    data: chartData
                }
            ]
        };
        myChart.setOption(option);
    }

    function renderStorageDetails(info, colors) {
        detailsList.innerHTML = '';
        const totalSize = info.totalSize;

        const totalSizeEl = document.getElementById('storage-total-size');
        if (totalSizeEl) {
            totalSizeEl.textContent = formatBytes(totalSize);
        }

        const sortedData = Object.entries(info.categorizedSizes)
            .map(([key, value]) => ({
                key: key,
                name: categoryNames[key] || key,
                value: value
            }))
            .sort((a, b) => b.value - a.value);

        sortedData.forEach((item, index) => {
            if (item.value <= 0) return; 
            const percentage = totalSize > 0 ? ((item.value / totalSize) * 100).toFixed(2) : 0;
            const color = colors[index % colors.length];

            const detailItem = document.createElement('div');
            detailItem.className = 'storage-detail-item';
            detailItem.innerHTML = `
                <div class="storage-color-indicator" style="background-color: ${color};"></div>
                <div class="storage-detail-info">
                    <span class="storage-detail-name">${item.name}</span>
                    <span class="storage-detail-size">${formatBytes(item.value)}</span>
                </div>
                <span class="storage-detail-percentage">${percentage}%</span>
            `;
            detailsList.appendChild(detailItem);
        });
    }

    const observer = new MutationObserver(async (mutations) => {
        if (screen.classList.contains('active')) {
            showToast('正在分析存储空间...');
            const storageInfo = await dataStorage.getStorageInfo();
            if (storageInfo) {
                renderStorageChart(storageInfo, colorPalette);
                renderStorageDetails(storageInfo, colorPalette);
                updatePersistenceStatus();
            } else {
                showToast('分析失败');
            }
        }
    });

    observer.observe(screen, { attributes: true, attributeFilter: ['class'] });

    async function updatePersistenceStatus() {
        if (navigator.storage && navigator.storage.persisted) {
            const isPersisted = await navigator.storage.persisted();
            let statusContainer = document.getElementById('storage-persistence-status');
            
            if (!statusContainer) {
                statusContainer = document.createElement('div');
                statusContainer.id = 'storage-persistence-status';
                statusContainer.style.cssText = "padding: 12px; background: #f8f9fa; border-radius: 12px; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center; border: 1px solid #eee;";
                chartContainer.parentNode.insertBefore(statusContainer, chartContainer);
            }
            
            statusContainer.innerHTML = `
                <div style="display: flex; flex-direction: column; gap: 4px;">
                    <div style="font-weight: 600; font-size: 15px; color: #333;">持久化存储保护</div>
                    <div style="font-size: 12px; color: ${isPersisted ? '#4caf50' : '#ff9800'}; display: flex; align-items: center; gap: 4px;">
                        ${isPersisted ? 
                            '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg> 已开启 (数据受保护)' : 
                            '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg> 未开启 (容易被清理)'}
                    </div>
                </div>
                ${!isPersisted ? '<button id="manual-persist-btn" class="btn btn-small btn-primary" style="padding: 6px 12px; font-size: 13px;">立即开启</button>' : ''}
            `;

            const btn = document.getElementById('manual-persist-btn');
            if (btn) {
                btn.onclick = async () => {
                    const persisted = await navigator.storage.persist();
                    if (persisted) {
                        showToast("已成功开启持久化存储！");
                        updatePersistenceStatus();
                    } else {
                        showToast("开启失败，可能是浏览器策略限制。");
                    }
                };
            }
        }
    }
}

// --- 持久化存储逻辑 ---
async function checkAndRequestPersistence() {
    if (navigator.storage && navigator.storage.persist) {
        const isPersisted = await navigator.storage.persisted();
        if (isPersisted) {
            console.log("Storage is already persisted.");
            return;
        }

        // 检查是否已经提示过
        const hasPrompted = localStorage.getItem('storage_persist_prompted');
        if (hasPrompted) return;

        // 显示弹窗
        showPersistencePrompt();
    }
}

function showPersistencePrompt() {
    // 避免重复弹窗
    if (document.getElementById('persistence-modal')) return;

    const modal = document.createElement('div');
    modal.id = 'persistence-modal';
    modal.className = 'modal-overlay visible';
    modal.style.zIndex = '10000';
    modal.innerHTML = `
        <div class="modal-window" style="max-width: 320px;">
            <h3 style="margin-bottom: 10px;">🛡️ 防止数据丢失</h3>
            <p style="color: #666; line-height: 1.6; margin-bottom: 20px; font-size: 14px;">
                为了避免聊天记录被浏览器自动清理，建议开启<strong>持久化存储</strong>保护。<br>
                <span style="font-size: 12px; color: #999; display: block; margin-top: 8px;">(开启后，浏览器将不会在空间不足时自动删除你的数据)</span>
            </p>
            <div style="display: flex; gap: 10px;">
                <button id="persist-allow-btn" class="btn btn-primary" style="flex: 1;">开启保护</button>
                <button id="persist-later-btn" class="btn btn-neutral" style="flex: 1;">稍后</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    document.getElementById('persist-allow-btn').onclick = async () => {
        const persisted = await navigator.storage.persist();
        if (persisted) {
            showToast("已成功开启持久化存储！");
        } else {
            showToast("开启失败，可能是浏览器策略限制。");
        }
        localStorage.setItem('storage_persist_prompted', 'true');
        modal.remove();
    };

    document.getElementById('persist-later-btn').onclick = () => {
        localStorage.setItem('storage_persist_prompted', 'true'); // 标记为已提示，避免每次刷新都弹
        modal.remove();
    };
}

// 导出函数供 main.js 使用
window.checkAndRequestPersistence = checkAndRequestPersistence;
window.setupStorageAnalysisScreen = setupStorageAnalysisScreen; // 确保原函数也被导出（虽然它已经是全局的）
