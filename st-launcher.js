// UwU 小手机 - ST 扩展启动器
// 加载方式：ST 把 manifest.js 当 ES module 注入到主页面
// 作用：在 ST 的"扩展菜单 (wand menu / #extensionsMenu)"加一个入口按钮
//        点击后新标签打开 UwU 主页面 /scripts/extensions/third-party/uwu/index.html

const UWU_URL = '/scripts/extensions/third-party/uwu/index.html';

function addUwUMenuButton() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu) {
        // 启动早于 wand menu 注入完成 → 轮询
        setTimeout(addUwUMenuButton, 500);
        return;
    }
    if (document.getElementById('uwu-wand-btn')) return; // 已存在不重复加

    const container = document.createElement('div');
    container.className = 'extension_container interactable';
    container.innerHTML = `
        <div id="uwu-wand-btn" class="list-group-item flex-container flexGap5 interactable" title="UwU 小手机 - 在新标签打开">
            <div class="fa-fw fa-solid fa-mobile-screen-button extensionsMenuExtensionButton"></div>
            <span>UwU 小手机</span>
        </div>
    `;
    container.addEventListener('click', () => {
        // 让事件冒泡（ST 会自动收起 wand menu）
        window.open(UWU_URL, '_blank', 'noopener');
    });
    menu.appendChild(container);
    console.log('[UwU 小手机] 入口按钮已注入');
}

// 启动
addUwUMenuButton();
