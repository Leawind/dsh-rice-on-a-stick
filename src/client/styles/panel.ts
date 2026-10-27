/**
 * 面板样式: 只引用宿主 --dsw-* token(var fallback 为亮色中性值, 宿主缺失时可读性兜底)。
 * 常驻文档头(apply 注入 <style>): 侧栏角标(dcs-glyph*)在页面未打开时也要有样式。
 * 控件规格对齐官方 primitives(输入 32px/radius-md, 按钮 sm 28/md 36, 开关 36×20,
 * 发丝分隔线 0.5px, 主按钮 = label-primary 黑白填充, 强调/焦点 = deepseek 蓝)。
 */
export const PANEL_CSS = [
  // 整页容器(中央面板): 自己是滚动容器(height:100% + overflow-y)——宿主主栏不代滚, 内容超高时
  // 没有这一层就上下都够不着。占满主栏宽度(不设 max-width, 表单行随面板伸缩)
  '.dcs-root{display:flex;flex-direction:column;gap:20px;width:100%;height:100%;min-height:0;box-sizing:border-box;padding:16px 28px 48px;overflow-y:auto;overflow-x:hidden;color:var(--dsw-alias-label-primary,#0f1115);}',
  // 顶部栏: 返回会话(弱化文本按钮, hover 才到主文字色; 沿用宿主面包屑的姿势)
  '.dcs-topbar{display:flex;margin:-6px 0 0;}',
  '.dcs-backbtn{display:inline-flex;align-items:center;gap:6px;padding:2px 4px;border:none;background:transparent;font-family:inherit;font-size:12.5px;line-height:20px;color:var(--dsw-alias-label-tertiary,#81858c);cursor:pointer;border-radius:var(--dsw-radius-sm,8px);transition:color .1s ease,background .1s ease;}',
  '.dcs-backbtn:hover{color:var(--dsw-alias-label-primary,#0f1115);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));}',
  '.dcs-backbtn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-state-business-primary,#4176e6);outline-offset:1px;}',
  '.dcs-backbtn svg{flex:none;}',
  // 页内标签(审批/设置): 官方页面标签同型, 选中态底线用强调蓝
  '.dcs-tabs{display:flex;gap:2px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));}',
  '.dcs-tab{position:relative;box-sizing:border-box;border:none;background:transparent;font-family:inherit;font-size:13px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-secondary,#61666b);height:36px;padding:8px 14px;cursor:pointer;border-radius:var(--dsw-radius-sm,8px) var(--dsw-radius-sm,8px) 0 0;transition:background .1s ease,color .1s ease;}',
  '.dcs-tab:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));color:var(--dsw-alias-label-primary,#0f1115);}',
  '.dcs-tab[data-on="1"]{color:var(--dsw-alias-label-primary,#0f1115);}',
  '.dcs-tab[data-on="1"]::after{content:"";position:absolute;left:10px;right:10px;bottom:-1px;height:2px;border-radius:1px;background:var(--dsw-alias-state-business-primary,#4176e6);}',
  '.dcs-tab:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-state-business-primary,#4176e6);outline-offset:-2px;}',
  // 标签上的待审批计数泡: 有停泊请求时出现; 剩余时间不足 1 分钟换紧急色
  '.dcs-tabcount{display:inline-block;box-sizing:border-box;min-width:17px;height:17px;margin-left:6px;padding:0 4px;border-radius:999px;corner-shape:round;font-size:11px;font-weight:600;line-height:17px;text-align:center;font-variant-numeric:tabular-nums;vertical-align:1px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 16%,transparent);color:var(--dsw-alias-state-warn-label,#dd8629);}',
  '.dcs-tabcount-urgent{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ec1313) 12%,transparent);color:var(--dsw-alias-state-error-primary,#ec1313);}',
  // 分组标题(设置标签内: MCP 服务 / 模型白名单 / 端点白名单 / MCP 令牌 / Agent 工具面 / 审批 / 安全与传输)
  '.dcs-grouphead{padding:10px 2px 0;}',
  // 带主开关的分组标题: 标题+副标题占左, 开关居右(两个类连写抬高优先级, 盖过 sechead 的 baseline 对齐)
  '.dcs-sechead.dcs-grouphead-ctl{align-items:center;}',
  '.dcs-headtext{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 auto;overflow-wrap:anywhere;}',
  '.dcs-headctl{flex:none;margin-left:auto;}',
  // 头部(品牌行: 图标 + 中文名 + 包名/版本, 状态徽章靠右)
  '.dcs-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
  '.dcs-icon{flex:none;width:28px;height:28px;}',
  '.dcs-icon svg{display:block;width:100%;height:100%;}',
  '.dcs-title{font-size:16px;font-weight:600;}',
  '.dcs-ver{font-size:12px;color:var(--dsw-alias-label-tertiary,#81858c);}',
  // 品牌块: 品牌行 + 一句话用途介绍, 整体作为一个行组参与根布局
  '.dcs-brand{display:flex;flex-direction:column;gap:6px;}',
  // 标语与下方端点卡之间在 6px 行距外再加一段呼吸空间
  '.dcs-tagline{font-size:12px;color:var(--dsw-alias-label-tertiary,#81858c);margin-bottom:10px;}',
  '.dcs-spacer{flex:1;}',
  // 状态徽章(官方 Tag 同型: 状态色 12% color-mix 底 + 同色文字 + 6px 点)
  '.dcs-tag{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border-radius:999px;corner-shape:round;font-size:12px;font-weight:500;}',
  '.dcs-dot{width:6px;height:6px;border-radius:50%;corner-shape:round;background:currentColor;}',
  '.dcs-tag-ok{color:var(--dsw-alias-state-success-primary,#22c55e);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 12%,transparent);}',
  '.dcs-tag-warn{color:var(--dsw-alias-state-warn-label,#dd8629);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 12%,transparent);}',
  '.dcs-tag-err{color:var(--dsw-alias-state-error-primary,#ec1313);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ec1313) 12%,transparent);}',
  // 按钮(官方 primitives: sm 28px/12px 字/radius-sm; md 36px/14px 字/radius-md; 主按钮 = label-primary 填充)
  '.dcs-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;height:28px;min-width:58px;padding:0 10px;border:none;border-radius:var(--dsw-radius-sm,8px);font-family:inherit;font-size:12px;cursor:pointer;background:transparent;color:var(--dsw-alias-label-primary,#0f1115);transition:background .1s ease,opacity .1s ease;}',
  '.dcs-btn:hover:enabled{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));}',
  '.dcs-btn:disabled{opacity:.4;cursor:default;}',
  '.dcs-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-state-business-primary,#4176e6);outline-offset:1px;}',
  '.dcs-btn-md{height:36px;padding:0 14px;border-radius:var(--dsw-radius-md,12px);font-size:14px;}',
  // 主按钮(label-primary 黑白填充, 官方 primary 同型): 审批卡的"允许"用
  '.dcs-btn-primary{background:var(--dsw-alias-label-primary,#0f1115);color:var(--dsw-alias-label-primary-foreground,#fff);}',
  '.dcs-btn-primary:hover:enabled{background:var(--dsw-alias-label-primary,#0f1115);opacity:.88;}',
  // 端点卡(官方 settings-card 同型: 填充底 + 半像素描边)
  '.dcs-card{display:flex;flex-direction:column;gap:6px;padding:12px 14px;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-1,#fff));box-shadow:var(--dsw-elevation-stroke,0 0 0 .5px var(--dsw-alias-border-l3,rgba(0,0,0,.12)));}',
  // 品牌块端点卡: 一行 = MCP 服务开关 + 监听地址/端口内嵌在端点 URL 里 + 复制按钮(右端)。
  // URL 由 http:// 前缀、地址/端口两个内联输入框和 /mcp 后缀拼成——编辑输入框即编辑端点本体
  '.dcs-endrow{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
  '.dcs-servicectl{flex:none;display:flex;align-items:center;gap:8px;}',
  '.dcs-servicename{font-size:13px;font-weight:500;}',
  '.dcs-endpoint{flex:1 1 300px;min-width:0;display:flex;align-items:center;gap:1px;font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:13px;line-height:24px;color:var(--dsw-alias-label-secondary,#61666b);font-variant-numeric:tabular-nums;overflow:hidden;}',
  '.dcs-endpoint[data-off="1"]{opacity:.55;}',
  // URL 里的地址/端口输入框: 无边框透明底融入 URL 文本, 悬停/聚焦浮现下划线表示可编辑
  '.dcs-urlseg{box-sizing:border-box;border:none;background:transparent;font-family:inherit;font-size:inherit;line-height:inherit;color:var(--dsw-alias-label-primary,#0f1115);border-bottom:.5px dashed transparent;border-radius:2px;padding:0 1px;outline:none;transition:border-color .1s ease;}',
  '.dcs-urlseg:hover{border-bottom-color:var(--dsw-alias-border-l3,rgba(0,0,0,.12));}',
  '.dcs-urlseg:focus{border-bottom-color:var(--dsw-alias-state-business-primary,#4176e6);}',
  '.dcs-urlseg:disabled{opacity:.5;cursor:default;}',
  '.dcs-urlseg::placeholder{color:var(--dsw-alias-label-dimmed,#979da6);}',
  // 端点卡的说明小字(服务用途 + 监听重建代价)
  '.dcs-endhint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#81858c);}',
  // 端点卡第二行: 自用工具开关(标签 + 说明居左, 开关居右), 与端点行之间画发丝线
  '.dcs-selfrow{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:10px;padding-top:10px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.10));}',
  '.dcs-selflabels{display:flex;flex-direction:column;gap:2px;min-width:0;}',
  '.dcs-selfname{font-size:12.5px;font-weight:600;}',
  '.dcs-err{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,#ec1313);}',
  // 设置表单(官方 SettingsForm 行式: 13px/500 标题 + 12px 副标题)
  '.dcs-form{display:flex;flex-direction:column;}',
  // 发丝线只画在配置行之间: 行下的附属块(白名单清单/令牌行/端点卡)属于同一项, 不另画线
  '.dcs-form > .dcs-row:not(:first-child){border-top:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.10));}',
  '.dcs-row{display:flex;align-items:center;justify-content:space-between;gap:24px;flex-wrap:wrap;padding:12px 2px;}',
  // 说明列可收缩且允许任意断行; 空间不够时控件整列换到下一行, 永远不会压到文字上
  '.dcs-labels{display:flex;flex-direction:column;gap:2px;flex:1 1 220px;min-width:0;overflow-wrap:anywhere;}',
  '.dcs-label{font-size:13px;line-height:20px;font-weight:500;}',
  '.dcs-sub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#81858c);}',
  // 控件列: 控件居右, 字段校验提示浮在控件下方(绝对定位, 不占据行高——出错时不会挤动其它行)
  '.dcs-controlwrap{position:relative;display:flex;flex-direction:column;align-items:flex-end;gap:4px;min-width:0;margin-left:auto;}',
  '.dcs-control{flex:none;display:flex;align-items:center;}',
  // 行内"输入框 + 应用": 数值/主机名这类字段与其它行同一套布局(标签左、控件右)
  '.dcs-inline{display:flex;align-items:center;gap:8px;}',
  '.dcs-inline .dcs-input{flex:none;width:130px;}',
  '.dcs-inline .dcs-input-wide{width:200px;}',
  // 输入框右侧的单位后缀(如审批等待时长的"秒")
  '.dcs-unit{flex:none;font-size:12px;color:var(--dsw-alias-label-secondary,#61666b);}',
  '.dcs-err-right{position:absolute;top:100%;right:0;margin-top:4px;max-width:320px;text-align:right;pointer-events:none;}',
  // 输入(官方 Input: 32px 高/0.5px border-l4/radius-md/焦点边框变品牌蓝)
  '.dcs-input{box-sizing:border-box;width:300px;max-width:100%;height:32px;padding:0 8px;font-family:inherit;font-size:14px;color:var(--dsw-alias-label-primary,#0f1115);background:var(--dsw-alias-bg-layer-1,#fff);border:.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.16));border-radius:var(--dsw-radius-md,12px);outline:none;transition:border-color .1s ease;}',
  '.dcs-input:focus{border-color:var(--dsw-alias-state-business-primary,#4176e6);}',
  '.dcs-input:disabled{opacity:.4;}',
  '.dcs-input::placeholder{color:var(--dsw-alias-label-dimmed,#979da6);}',
  'select.dcs-input{width:200px;padding-right:24px;}',
  // 开关(官方 Switch: 36×20 胶囊, 关轨 = border-l3, 开轨 = brand-primary, thumb 16px 位移 16px;
  // 宿主主题给所有元素设了 corner-shape:superellipse(1.5), 胶囊必须显式 corner-shape:round 才是正圆端)
  '.dcs-switch{box-sizing:border-box;position:relative;flex:none;width:36px;height:20px;padding:2px;border:0;border-radius:999px;corner-shape:round;cursor:pointer;background:var(--dsw-alias-border-l3,rgba(0,0,0,.2));transition:background .12s ease;}',
  '.dcs-switch::after{content:"";display:block;width:16px;height:16px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-switch-thumb,#fff);transition:transform .12s ease;}',
  '.dcs-switch[data-on="1"]{background:var(--dsw-alias-brand-primary,#0f1115);}',
  '.dcs-switch[data-on="1"]::after{transform:translateX(16px);background:var(--dsw-alias-label-primary-foreground,#fff);}',
  '.dcs-switch:disabled{opacity:.5;cursor:default;}',
  '.dcs-switch:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4176e6));outline-offset:2px;}',
  // 模型白名单: 多选分层树与端点白名单清单同构(dcs-eplist), 只多出简介编辑钮与行下编辑器
  '.dcs-listwrap{padding:0 2px 12px;display:flex;flex-direction:column;gap:8px;}',
  '.dcs-x{flex:none;width:22px;height:22px;padding:0;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#81858c);font-size:14px;line-height:1;cursor:pointer;transition:background .1s ease,color .1s ease;}',
  '.dcs-x:hover:enabled{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));color:var(--dsw-alias-state-error-primary,#ec1313);}',
  '.dcs-x:disabled{opacity:.4;cursor:default;}',
  '.dcs-listmsg{font-size:12px;color:var(--dsw-alias-label-tertiary,#81858c);padding:2px;}',
  // MCP令牌行(重新生成需二次确认: 待确认时按钮临时换成"确认/取消", 警示说明挂在行下; 窄面板可换行)
  '.dcs-tokenrow{display:flex;align-items:center;gap:8px;padding-top:10px;flex-wrap:wrap;}',
  '.dcs-tokenwarn{font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-label,#dd8629);}',
  '.dcs-tokeninput{flex:1;min-width:80px;height:28px;padding:0 8px;font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:12px;color:var(--dsw-alias-label-secondary,#61666b);background:var(--dsw-alias-bg-layer-1,#fff);border:.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.16));border-radius:var(--dsw-radius-sm,8px);outline:none;}',
  // 端点白名单清单: 过滤+全选行在上, 组头(组复选+namespace+计数)与端点行(复选+端点+说明+锁定徽标)在下
  '.dcs-eps{display:flex;flex-direction:column;gap:8px;width:100%;}',
  '.dcs-epbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
  '.dcs-epbar .dcs-input{flex:1 1 200px;width:auto;min-width:160px;height:28px;font-size:12px;}',
  '.dcs-epall{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary,#61666b);white-space:nowrap;cursor:pointer;}',
  // 清单独立滚动: overscroll-behavior:contain 阻断滚动链接——滚到顶/底后继续滚不会带动外层页面,
  // 面板不会因"外层接着滚"而整体位移(鼠标在清单内时滚动始终由清单自己消费)。
  // 端点白名单的两个清单(-flat)不限高: 完整展示, 页面整体滚动
  '.dcs-eplist{display:flex;flex-direction:column;max-height:320px;overflow:auto;overscroll-behavior:contain;padding:4px 10px;background:var(--dsw-alias-bg-layer-1,#fff);border:.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.16));border-radius:var(--dsw-radius-md,12px);}',
  '.dcs-eplist-flat{max-height:none;overflow:visible;overscroll-behavior:auto;}',
  '.dcs-epgroup{display:flex;align-items:center;gap:8px;padding:5px 0;cursor:pointer;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.10));}',
  '.dcs-epgroup:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.04));}',
  '.dcs-epgroup:last-child,.dcs-epr:last-child{border-bottom:none;}',
  // 分组折叠/展开: grid-rows 0fr→1fr 过渡(内容高未知也能平滑动画), 内容层 overflow:hidden 裁剪
  '.dcs-epbody{display:grid;grid-template-rows:0fr;transition:grid-template-rows .2s ease;}',
  '.dcs-epbody-open{grid-template-rows:1fr;}',
  '.dcs-epbodyin{overflow:hidden;min-height:0;}',
  '.dcs-epchev{flex:none;width:16px;text-align:center;color:var(--dsw-alias-label-secondary,#61666b);font-size:15px;line-height:1;}',
  '.dcs-epns{font-size:12.5px;font-weight:600;}',
  '.dcs-epnsdesc{flex:1;min-width:0;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#81858c);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
  '.dcs-epcount{flex:none;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#81858c);font-variant-numeric:tabular-nums;white-space:nowrap;}',
  // 端点行左缩进 46px = 组头里 namespace 文本的起点(16 箭头 + 8 间距 + 14 组复选 + 8 间距), 端点复选框与 namespace 对齐成树状
  '.dcs-epr{display:flex;align-items:center;gap:8px;padding:4px 0 4px 46px;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.10));}',
  // 整行可点(流式行除外, 不加指针): 点行任意处 = 切换该行勾选
  '.dcs-epr-live{cursor:pointer;}',
  '.dcs-epr-live:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.04));}',
  '.dcs-eprname{flex:none;font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:12px;}',
  // 描述只占自然宽度(超长收缩省略), 后随弹性占位把徽标恒推到行右端——描述缺失时徽标同样靠右
  '.dcs-eprdesc{flex:0 1 auto;min-width:0;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#81858c);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
  '.dcs-eprfill{flex:1 1 0;}',
  '.dcs-epchk{flex:none;width:14px;height:14px;margin:0;accent-color:var(--dsw-alias-brand-primary,#0f1115);cursor:pointer;}',
  '.dcs-epchk:disabled{opacity:.35;cursor:default;}',
  '.dcs-epbadge{flex:none;display:inline-flex;align-items:center;height:18px;padding:0 7px;border-radius:999px;corner-shape:round;font-size:11px;}',
  '.dcs-epbadge-read{color:var(--dsw-alias-state-success-primary,#22c55e);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 12%,transparent);}',
  '.dcs-epbadge-write{color:var(--dsw-alias-state-business-primary,#4176e6);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 12%,transparent);}',
  '.dcs-epbadge-stream{color:var(--dsw-alias-label-tertiary,#81858c);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));}',
  '.dcs-epbadge-danger{color:var(--dsw-alias-state-error-primary,#ec1313);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ec1313) 10%,transparent);}',
  '.dcs-epbadge-stale{color:var(--dsw-alias-state-warn-label,#dd8629);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 12%,transparent);}',
  // 危险端点独立清单的段头: 错误色标题 + 危险徽标 + 一句话提醒
  '.dcs-epdangerhead{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;padding:2px 2px 0;}',
  '.dcs-epdangerhead .dcs-sectitle{color:var(--dsw-alias-state-error-primary,#ec1313);}',
  '.dcs-epdangerhead .dcs-sub{flex:1;min-width:160px;}',
  // 模型白名单树: 与端点白名单清单同构(组头 = 箭头+组复选+名称+计数; 行 = 复选+名称+简介+编辑钮)。
  // 简介编辑钮(✎)是弱化幽灵按钮, 悬停才浮出; 编辑行是行下展开的 textarea, 失焦即存
  '.dcs-mrow{display:flex;align-items:center;gap:8px;padding:4px 0 4px 46px;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.10));}',
  '.dcs-mpair{display:flex;align-items:baseline;gap:6px;min-width:0;}',
  '.dcs-mname{flex:none;font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:12px;}',
  '.dcs-mdesc{flex:0 1 auto;min-width:0;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#81858c);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
  '.dcs-pen{flex:none;width:22px;height:22px;padding:0;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#81858c);font-size:12px;line-height:1;cursor:pointer;transition:background .1s ease,color .1s ease;}',
  '.dcs-pen:hover:enabled{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));color:var(--dsw-alias-label-primary,#0f1115);}',
  '.dcs-pen[data-on="1"]{color:var(--dsw-alias-state-business-primary,#4176e6);}',
  '.dcs-descedit{display:flex;flex-direction:column;gap:4px;padding:4px 0 8px 46px;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.10));}',
  '.dcs-descedit.dcs-descedit-provider{padding-left:24px;}',
  '.dcs-descedit textarea{box-sizing:border-box;width:100%;min-height:52px;max-height:160px;padding:6px 8px;font-family:inherit;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-primary,#0f1115);background:var(--dsw-alias-bg-layer-1,#fff);border:.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.16));border-radius:var(--dsw-radius-sm,8px);outline:none;resize:vertical;transition:border-color .1s ease;}',
  '.dcs-descedit textarea:focus{border-color:var(--dsw-alias-state-business-primary,#4176e6);}',
  '.dcs-descedit textarea::placeholder{color:var(--dsw-alias-label-dimmed,#979da6);}',
  '.dcs-epstale{display:flex;align-items:center;gap:8px;padding:4px 0 4px 20px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.10));}',
  '.dcs-epstale .dcs-eprname{color:var(--dsw-alias-state-warn-label,#dd8629);}',
  // 自绘 tooltip(挂 body 的单例浮层, .dcs-tip 常驻仅显隐): fixed 定位不受滚动容器裁剪, pre-line 支持 \n 分行;
  // 内容可含胶囊徽标(与行内徽标同款), 徽标之间留 6px 间距
  '.dcs-tip{display:none;position:fixed;z-index:2147483000;max-width:460px;padding:6px 10px;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-primary,#0f1115);background:var(--dsw-alias-bg-layer-1,#fff);border:.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.16));border-radius:var(--dsw-radius-sm,8px);box-shadow:0 6px 20px rgba(0,0,0,.14);pointer-events:none;white-space:pre-line;word-break:break-word;}',
  '.dcs-tip .dcs-epbadge{vertical-align:-4px;}',
  '.dcs-tip .dcs-epbadge + .dcs-epbadge,.dcs-tip .dcs-epbadge + *{margin-left:6px;}',
  // 端点写调用审批列表(动作关键面): 头部(标题 + 停泊计数 + 全部拒绝) + 说明行 + 每条停泊请求一张独立小卡;
  // 卡顶细条按剩余时间占比收缩, 不足 1 分钟转紧急红; 新卡轻轻浮入(prefers-reduced-motion 时关闭)
  '.dcs-apprs{display:flex;flex-direction:column;gap:8px;}',
  '.dcs-apprs-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;padding:10px 2px 0;}',
  '.dcs-apprs-desc{padding:0 2px;}',
  '@keyframes dcs-appr-in{from{opacity:0;transform:translateY(3px);}to{opacity:1;transform:none;}}',
  '.dcs-appr{position:relative;overflow:hidden;gap:8px;animation:dcs-appr-in .18s ease-out;}',
  '@media (prefers-reduced-motion:reduce){.dcs-appr{animation:none;}.dcs-apprbar{transition:none;}}',
  '.dcs-apprbar{position:absolute;top:0;left:0;height:2px;max-width:100%;background:var(--dsw-alias-state-warn-primary,#f59e0b);transition:width 1s linear,background .2s ease;}',
  '.dcs-apprbar-urgent{background:var(--dsw-alias-state-error-primary,#ec1313);}',
  '.dcs-apprhead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
  '.dcs-apprendpoint{font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:13px;font-weight:600;word-break:break-all;}',
  '.dcs-apprwait{margin-left:auto;font-size:12px;color:var(--dsw-alias-label-tertiary,#81858c);font-variant-numeric:tabular-nums;white-space:nowrap;}',
  '.dcs-apprwait-urgent{color:var(--dsw-alias-state-error-primary,#ec1313);font-weight:500;}',
  // 参数摘要: 以 label-primary 4% 中性微染的代码块, 深浅主题都比卡片底深/浅一档, 不再画边框
  '.dcs-apprargs{margin:0;padding:8px 10px;max-height:140px;overflow:auto;overscroll-behavior:contain;font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary,#61666b);background:color-mix(in srgb,var(--dsw-alias-label-primary,#0f1115) 4%,transparent);border-radius:var(--dsw-radius-sm,8px);white-space:pre-wrap;word-break:break-all;}',
  '.dcs-apprbtns{display:flex;align-items:center;gap:8px;}',
  // 危险动作的次级按钮: 发丝描边, 悬停才上错误色(拒绝/全部拒绝用)
  '.dcs-btn-danger{color:var(--dsw-alias-label-secondary,#61666b);box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l4,rgba(0,0,0,.16));}',
  '.dcs-btn-danger:hover:enabled{color:var(--dsw-alias-state-error-primary,#ec1313);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ec1313) 8%,transparent);box-shadow:inset 0 0 0 .5px color-mix(in srgb,var(--dsw-alias-state-error-primary,#ec1313) 28%,transparent);}',
  // 审批空态: 居中虚线框(碗图标 + 一句话; 文案保持单句, 不预设读写语义)
  '.dcs-apprsempty{display:flex;flex-direction:column;align-items:center;gap:4px;padding:44px 16px 40px;border:.5px dashed var(--dsw-alias-border-l3,rgba(0,0,0,.12));border-radius:var(--dsw-radius-md,12px);text-align:center;}',
  '.dcs-apprsempty .dcs-icon{width:26px;height:26px;opacity:.5;margin-bottom:4px;}',
  '.dcs-apprsempty-main{font-size:13px;font-weight:500;color:var(--dsw-alias-label-secondary,#61666b);}',
  // 侧栏面板图标(本插件注册的 sidebar.panellist 条目): 米饭碗 + 待审批计数角标。
  // 渲染在宿主侧栏按钮里, 不受页面开关影响——样式必须常驻文档头而非随页面注入
  '.dcs-glyph{position:relative;display:block;flex:none;}',
  '.dcs-glyph-icon{display:block;width:100%;height:100%;}',
  '.dcs-glyph-icon svg{display:block;width:100%;height:100%;}',
  '.dcs-glyphbadge{position:absolute;top:-5px;right:-7px;box-sizing:border-box;min-width:15px;height:15px;padding:0 4px;border-radius:999px;corner-shape:round;background:var(--dsw-alias-state-warn-primary,#f59e0b);color:#fff;font-size:10px;font-weight:600;line-height:15px;text-align:center;font-variant-numeric:tabular-nums;pointer-events:none;}',
  '.dcs-glyphbadge-urgent{background:var(--dsw-alias-state-error-primary,#ec1313);}',
  '.dcs-savebar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:14px 2px 2px;}',
  '.dcs-sechead{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;padding-bottom:4px;}',
  '.dcs-sectitle{font-size:13px;font-weight:600;}',
  '.dcs-table{display:flex;flex-direction:column;}',
  '.dcs-tr{display:grid;grid-template-columns:minmax(110px,1fr) 56px 84px 92px 48px;gap:10px;align-items:center;padding:7px 2px;font-size:12.5px;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.10));}',
  '.dcs-tr:last-child{border-bottom:none;}',
  '.dcs-trh{font-size:12px;color:var(--dsw-alias-label-tertiary,#81858c);border-bottom-color:var(--dsw-alias-border-l3,rgba(0,0,0,.12));}',
  '.dcs-ua{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
  '.dcs-num{text-align:right;font-variant-numeric:tabular-nums;}',
  '.dcs-empty{font-size:12.5px;color:var(--dsw-alias-label-tertiary,#81858c);padding:8px 2px;}',
].join('');
