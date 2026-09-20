/**
 * Spine 骨架预览渲染器（Canvas 2D）
 *
 * 为什么不用 spine-webgl 运行时：
 *   webgl 运行时要求把切图打成 atlas（.atlas + .png），而我们的产物是
 *   一张张独立的 PNG。为了能看到效果而额外引入 atlas 打包，会把
 *   "能预览"变成"必须先导出"，反馈太慢。这里直接按骨骼变换逐张贴图，
 *   对纯 region 附件来说和运行时结果一致。
 *
 * 坐标约定：
 *   图片像素坐标（左上原点，Y 向下）
 *   Spine 坐标（原点在图片中心，Y 向上）
 * 渲染时把 Spine 坐标再翻回屏幕坐标，所以看到的方向和原图一致。
 */

export class SpinePreview {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.skeleton = null;
    this.images = new Map(); // 部件名 → Image
    this.animation = null;
    this.animationName = null;
    this.time = 0;
    this.speed = 1;
    this.zoom = 1;
    this.playing = true;
    this.lastFrame = 0;
    this._raf = null;

    // 逐帧步进的基准帧率。Spine 编辑器默认 30，跟它对齐，
    // 这样"第 12 帧接缝裂开"在两边说的是同一帧。
    this.fps = 30;
    this.loop = true;
    this.showBones = false;
    this.showWireframe = false;
    /*
     * 对齐诊断叠加层。AI 给的是矩形框、部件不是矩形，框多框进来的内容会
     * 跟着部件一起动——用户看到的"缺块"多半就是这么来的。这一层直接把
     * AI 原框、吸附后的框、以及框内不透明占比画在预览上，不用再靠肉眼
     * 在动画里一个部件一个部件地猜。
     */
    this.showBbox = false;
    this.alignment = null;

    // 视图平移（屏幕像素）。放大看关节时得能挪到画面外的部件
    this.panX = 0;
    this.panY = 0;

    // 每帧回调，用来把播放进度同步给 UI
    this.onFrame = null;

    // 适配高分屏，否则线条和图片在 Retina 上会糊
    this.dpr = window.devicePixelRatio || 1;
  }

  /**
   * 加载骨架与图片资源
   * @param {object} skeleton - Spine JSON
   * @param {Map<string,string>} imageUrls - 部件名 → 图片 URL
   * @param {{width:number,height:number}} [imageSize] - 原图尺寸，用于适配缩放
   */
  async load(skeleton, imageUrls, imageSize) {
    this.skeleton = skeleton;
    this.imageSize = imageSize ?? null;
    this.images.clear();

    const jobs = [...imageUrls.entries()].map(([name, url]) => {
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          this.images.set(name, img);
          resolve();
        };
        img.onerror = () => {
          console.warn(`[预览] 图片加载失败: ${name} (${url})`);
          resolve();
        };
        img.src = url;
      });
    });

    await Promise.all(jobs);
    console.log(`[预览] 已加载 ${this.images.size}/${imageUrls.size} 张部件图片`);

    const names = Object.keys(skeleton.animations ?? {});
    if (names.length) {
      this.playAnimation(names[0]);
    } else {
      this.animation = null;
      this.time = 0;
    }

    this.resize();
    return this.images.size;
  }

  playAnimation(name) {
    if (!this.skeleton?.animations?.[name]) return;
    this.animationName = name;
    this.animation = this.skeleton.animations[name];
    this.time = 0;

    // 动画时长 = 所有轨道最后一个关键帧时间的最大值
    let duration = 0;
    for (const track of Object.values(this.animation.bones ?? {})) {
      for (const keys of Object.values(track)) {
        for (const k of keys) {
          if (k.time > duration) duration = k.time;
        }
      }
    }
    this.duration = duration || 1;
  }

  setSpeed(speed) {
    this.speed = speed;
  }

  setZoom(zoom) {
    this.zoom = zoom;
  }

  reset() {
    this.time = 0;
    this.speed = 1;
    this.zoom = 1;
    this.playing = true;
    this.panX = 0;
    this.panY = 0;
  }

  // --- 播放控制 ---
  //
  // 检查骨骼绑定得看单帧：动画一直在跑的话，接缝错位一闪而过，
  // 根本判断不了是权重不对还是 pivot 不对。所以暂停和逐帧是必需的，
  // 不是锦上添花。

  play() {
    this.playing = true;
  }

  pause() {
    this.playing = false;
  }

  togglePlay() {
    this.playing = !this.playing;
    return this.playing;
  }

  /** 跳到指定时刻并暂停。拖时间轴时用 */
  seek(time) {
    const d = this.duration || 1;
    this.time = Math.max(0, Math.min(d, time));
    this.playing = false;
  }

  /**
   * 逐帧步进。
   * 按 fps 折算成时间量，末尾回绕到开头——正好用来反复看循环接缝处那一帧。
   */
  step(frames = 1) {
    const d = this.duration || 1;
    this.playing = false;
    this.time += frames / this.fps;
    if (this.time > d) this.time -= d;
    if (this.time < 0) this.time += d;
    return this.time;
  }

  /** 停止：回到第 0 帧的静止姿势。和暂停不同，这是复位 */
  stopPlayback() {
    this.playing = false;
    this.time = 0;
  }

  setLoop(loop) {
    this.loop = loop;
  }

  setFps(fps) {
    this.fps = Math.max(1, fps);
  }

  /** 视图平移，配合缩放看关节细节 */
  setPan(x, y) {
    this.panX = x;
    this.panY = y;
  }

  toggleBones() {
    this.showBones = !this.showBones;
    return this.showBones;
  }

  /** 线框：直接看出三角剖分和形变，权重错了会表现为三角形被拉飞 */
  toggleWireframe() {
    this.showWireframe = !this.showWireframe;
    return this.showWireframe;
  }

  /**
   * 按容器尺寸调整画布，保持正方形逻辑坐标以简化居中换算。
   *
   * 这里只改后备缓冲区（canvas.width/height），绝不回写内联 style 尺寸。
   * 回写会形成正反馈：量出容器 774px → 写成 style.width:774px →
   * 画布因此有了 774px 的最小内容宽 → 1fr 轨道必须让到 774+2（容器边框）→
   * 下次再量就是 776…… 每调用一次布局就宽 2px，点几次记录列表页面就横向溢出。
   * 画布的显示尺寸交给 CSS（absolute + inset:0）负责，它不参与固有尺寸计算。
   */
  resize() {
    // 画布自己的盒子才是真正要画的区域；它隐藏时量不到，退回容器
    const rect = this.canvas.getBoundingClientRect();
    const box = this.canvas.parentElement.getBoundingClientRect();
    const width = Math.max(rect.width || box.width, 100);
    const height = Math.max(rect.height || box.height, 100);

    this.canvas.width = Math.round(width * this.dpr);
    this.canvas.height = Math.round(height * this.dpr);

    this.viewWidth = width;
    this.viewHeight = height;

    // 以原图尺寸为基准算出适配缩放。
    // 不再限制"只缩不放"：小图会缩在画布中间一小块，看不清接缝和形变。
    // 留 8% 边距，因为动画里部件会转出原图范围，贴边会被裁掉。
    const size = this.imageSize;
    if (size?.width && size?.height) {
      this.fitScale = Math.min(width / size.width, height / size.height) * 0.92;
    } else {
      this.fitScale = 1;
    }
  }

  start() {
    if (this._raf) return;
    this.lastFrame = performance.now();
    const tick = (now) => {
      const dt = (now - this.lastFrame) / 1000;
      this.lastFrame = now;
      if (this.playing) {
        this.time += dt * this.speed;
        if (this.duration && this.time > this.duration) {
          if (this.loop) {
            this.time -= this.duration;
          } else {
            this.time = this.duration;
            this.playing = false;
          }
        }
      }
      // canvas 从 display:none 变成 block 时，首帧 clientWidth 可能仍是 0
      // （布局还没刷新），导致 resize() 把画布算成 0x0，内容永远画不出来。
      // 只要发现宽度变了就重新 resize，不会带来额外开销。
      const curW = this.canvas?.clientWidth ?? 0;
      if (curW !== this._lastKnownW) {
        this._lastKnownW = curW;
        this.resize();
      }
      this.draw();
      this.onFrame?.(this.time, this.duration || 1, this.playing);
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  /**
   * 取附件定义。
   * skins 在 Spine 3.8+ 是数组 [{name, attachments}]，3.7 及更早是对象。
   * 导入的第三方骨架两种都可能碰到，这里都接。
   */
  attachmentOf(slotName, attachmentName) {
    const skins = this.skeleton?.skins;
    if (!skins || !attachmentName) return null;

    const bySkin = Array.isArray(skins)
      ? skins.find((s) => s.name === 'default') ?? skins[0]
      : skins.default;

    return bySkin?.attachments?.[slotName]?.[attachmentName] ?? null;
  }

  /**
   * 每根骨骼在静止姿势下的世界变换。
   *
   * 为什么必须单独算：骨架里 bone.x/bone.y 存的是「相对父骨骼」的偏移，
   * 而蒙皮公式 currentWorld × restWorld⁻¹ 里的 currentWorld 是世界坐标。
   * 直接拿 bone.x/bone.y 当 restWorld，子骨骼就会少掉整条父链的位移，
   * 网格被推到别处——表现就是部件拼不回原图、画面盖不满。
   *
   * 结果按骨架缓存：静止姿势不随时间变，每帧重算是白费。
   */
  restWorld() {
    if (this._restWorld && this._restWorldFor === this.skeleton) return this._restWorld;

    const bones = this.skeleton?.bones ?? [];
    const byName = new Map(bones.map((b) => [b.name, b]));
    const world = new Map();

    const resolve = (name, guard = 0) => {
      if (world.has(name)) return world.get(name);
      const bone = byName.get(name);
      if (!bone || guard > bones.length) return { x: 0, y: 0, rot: 0 };

      const parent = bone.parent ? resolve(bone.parent, guard + 1) : { x: 0, y: 0, rot: 0 };
      const rad = (parent.rot * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const lx = bone.x ?? 0;
      const ly = bone.y ?? 0;

      const w = {
        x: parent.x + lx * cos - ly * sin,
        y: parent.y + lx * sin + ly * cos,
        rot: parent.rot + (bone.rotation ?? bone.rot ?? 0)
      };
      world.set(name, w);
      return w;
    };

    for (const b of bones) resolve(b.name);

    this._restWorld = world;
    this._restWorldFor = this.skeleton;
    return world;
  }

  /** 采样关键帧：线性插值，带 stepped 时保持前一帧 */
  static sample(keys, time) {
    if (!keys?.length) return 0;
    if (time <= keys[0].time) return keys[0].value;
    if (time >= keys[keys.length - 1].time) return keys[keys.length - 1].value;

    for (let i = 0; i < keys.length - 1; i++) {
      const a = keys[i];
      const b = keys[i + 1];
      if (time >= a.time && time <= b.time) {
        if (a.curve === 'stepped') return a.value;
        const span = b.time - a.time;
        const t = span > 0 ? (time - a.time) / span : 0;
        return a.value + (b.value - a.value) * t;
      }
    }
    return keys[keys.length - 1].value;
  }

  /** 取出某个骨骼在某个时刻的变换 */
  boneTransform(boneName) {
    const track = this.animation?.bones?.[boneName];
    if (!track) return { tx: 0, ty: 0, rotate: 0 };

    const tl = track.translate?.map((k) => ({ time: k.time, value: k.x ?? 0, curve: k.curve }));
    const ty = track.translate?.map((k) => ({ time: k.time, value: k.y ?? 0, curve: k.curve }));
    // 旋转键名：3.8 是 angle，4.0 起是 value。两种都读，省得跟导出版本绑死
    const rot = track.rotate?.map((k) => ({
      time: k.time,
      value: k.value ?? k.angle ?? 0,
      curve: k.curve
    }));

    // translate 是相对静止姿势的偏移，直接用。
    // 之前减去 bone.x/bone.y 是在抵消生成端误写的绝对坐标；
    // 生成端已改成偏移量，这里再减一次就会把角色推出画面。
    return {
      tx: tl?.length ? SpinePreview.sample(tl, this.time) : 0,
      ty: ty?.length ? SpinePreview.sample(ty, this.time) : 0,
      rotate: rot?.length ? SpinePreview.sample(rot, this.time) : 0
    };
  }

  draw() {
    const ctx = this.ctx;
    const skeleton = this.skeleton;
    if (!skeleton) return;

    const W = this.viewWidth;
    const H = this.viewHeight;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // 背景网格
    ctx.strokeStyle = '#161C28';
    ctx.lineWidth = 1;
    for (let x = 0; x < W; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }
    for (let y = 0; y < H; y += 40) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }

    // 世界变换：Spine 坐标 → 屏幕坐标
    const scale = this.fitScale * this.zoom;
    const cx = W / 2 + this.panX;
    const cy = H / 2 + this.panY;

    // 预先算好每个骨骼的世界变换。
    //
    // 这里一律用 Spine 单位（未缩放），显示缩放只在 toScreen 里施加一次。
    // 之前把 scale 存进 world 再让 toScreen 又乘一遍，子骨骼偏移实际按
    // scale² 计算，部件会朝根骨骼收缩——图越大 fitScale 越小，收缩越明显，
    // 拼出来就盖不满原图。
    const world = new Map();
    for (const bone of skeleton.bones) {
      const t = this.boneTransform(bone.name);
      const parent = bone.parent ? world.get(bone.parent) : null;

      const lx = (bone.x ?? 0) + t.tx;
      const ly = (bone.y ?? 0) + t.ty;

      if (!parent) {
        world.set(bone.name, { x: lx, y: ly, rot: t.rotate });
      } else {
        const rad = (parent.rot * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);

        world.set(bone.name, {
          x: parent.x + lx * cos - ly * sin,
          y: parent.y + lx * sin + ly * cos,
          rot: parent.rot + t.rotate
        });
      }
    }

    // Spine 坐标（Y 向上）→ 屏幕坐标（Y 向下）
    const toScreen = (wx, wy) => ({ x: cx + wx * scale, y: cy - wy * scale });

    // 按槽位顺序绘制图片
    for (const slot of skeleton.slots ?? []) {
      // world 里存的是 Spine 坐标系下的世界变换（原点居中，Y 向上）
      const bone = world.get(slot.bone);
      if (!bone) continue;

      const attachment = this.attachmentOf(slot.name, slot.attachment);
      const img = this.images.get(slot.bone);
      if (!img) continue;

      if (attachment?.type === 'mesh') {
        this.drawMesh(attachment, slot, world, img, toScreen);
        continue;
      }

      const ox = attachment?.x ?? 0;
      const oy = attachment?.y ?? 0;

      // attachment 原点在图片中心，偏移相对骨骼原点（Spine 单位，未缩放）
      const rad = (bone.rot * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);

      const worldX = bone.x + (ox * cos - oy * sin);
      const worldY = bone.y + (ox * sin + oy * cos);
      const screen = toScreen(worldX, worldY);

      ctx.save();
      ctx.translate(screen.x, screen.y);
      // Spine 的旋转是逆时针为正，屏幕坐标 Y 向下，所以要取反
      ctx.rotate((-bone.rot * Math.PI) / 180);
      ctx.scale(scale, scale);
      ctx.drawImage(img, -img.width / 2, -img.height / 2, img.width, img.height);
      ctx.restore();
    }

    // 骨骼叠加层，标出每根骨骼的原点并连出父子关系。
    // 只画点看不出层级，连线才能确认 AI 拆出的父子关系对不对。
    if (this.showBones) {
      ctx.save();
      ctx.strokeStyle = 'rgba(56,189,248,0.55)';
      ctx.lineWidth = 1.5;
      for (const bone of skeleton.bones) {
        if (!bone.parent) continue;
        const a = world.get(bone.parent);
        const b = world.get(bone.name);
        if (!a || !b) continue;
        const sa = toScreen(a.x, a.y);
        const sb = toScreen(b.x, b.y);
        ctx.beginPath();
        ctx.moveTo(sa.x, sa.y);
        ctx.lineTo(sb.x, sb.y);
        ctx.stroke();
      }
      for (const bone of skeleton.bones) {
        // bone.x/y 是相对父骨骼的偏移，标点要用累加后的世界坐标
        const w = world.get(bone.name);
        if (!w) continue;
        const s = toScreen(w.x, w.y);
        ctx.fillStyle = bone.parent ? '#38BDF8' : '#10B981';
        ctx.beginPath();
        ctx.arc(s.x, s.y, 4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    if (this.showBbox && this.alignment?.length) {
      this.drawAlignment(world, toScreen);
    }
  }

  /**
   * 画对齐诊断：AI 原框 vs 吸附后的框。
   *
   * 这是排查"缺块"最快的一条路。AI 只输出矩形框，而部件不是矩形——
   * 框大出来的部分会把邻件内容一起切进来，动画里就表现为某块内容
   * 跟着错误的部件在动。两个框画在一起，偏没偏一眼就看得到：
   *
   *   虚线 = AI 给的框（黄色）
   *   实线 = 切图实际用的框（绿色）
   *   两个框差得越多，说明 AI 框得越离谱
   *
   * 旋转量取静止姿势（restWorld）而不是当前帧：静止姿势就是部件拼回
   * 原图的那一帧，只有在这一帧上，框的位置才和原图坐标一一对应。
   */
  drawAlignment(world, toScreen) {
    const ctx = this.ctx;
    const byName = new Map(this.alignment.map((a) => [a.name, a]));

    for (const bone of this.skeleton.bones) {
      const a = byName.get(bone.name);
      if (!a?.bbox) continue;
      const w = world.get(bone.name);
      if (!w) continue;

      // 静止姿势下的旋转角，用来把轴对齐的框摆回它该在的朝向
      const rest = this.restWorld().get(bone.name);
      const rot = ((rest?.rot ?? 0) * Math.PI) / 180;

      const drawBox = (b, color, dash) => {
        // bbox 是原图像素坐标（Y 向下）；Spine 顶点空间 Y 向上，
        // 而且原点在部件中心（attachment 原点 = 图心）
        const pts = [
          [b.x, b.y],
          [b.x + b.width, b.y],
          [b.x + b.width, b.y + b.height],
          [b.x, b.y + b.height]
        ].map(([px, py]) => {
          const ux = px - (b.x + b.width / 2);
          const uy = -(py - (b.y + b.height / 2));
          const rx = ux * Math.cos(rot) - uy * Math.sin(rot);
          const ry = ux * Math.sin(rot) + uy * Math.cos(rot);
          return toScreen(w.x + rx, w.y + ry);
        });

        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        if (dash) ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.closePath();
        ctx.stroke();
        ctx.restore();
      };

      if (a.originalBbox) drawBox(a.originalBbox, 'rgba(250,204,21,0.85)', true);
      drawBox(a.bbox, 'rgba(52,211,153,0.9)', false);

      // 框内过半是空的部件，把名字标出来，省得一个个对着看
      if (a.flags?.length) {
        const s = toScreen(w.x, w.y);
        ctx.save();
        ctx.font = '12px system-ui, sans-serif';
        ctx.fillStyle = '#F87171';
        ctx.fillText(`${a.name} ${(a.fillRatio * 100).toFixed(0)}%`, s.x + 6, s.y - 6);
        ctx.restore();
      }
    }
  }

  /**
   * 绘制蒙皮网格。
   *
   * 蒙皮的本质：顶点位置 = Σ(权重 × 骨骼变换 × 静止位置)。
   * 每个顶点因此不再绑定单根骨骼，关节两侧的顶点会被两边共同拉扯，
   * 转动时接缝就跟着走，而不是硬生生裂开。
   *
   * 网格已经三角剖分好，这里逐三角形做纹理映射——
   * 用 UV 空间到屏幕空间的仿射变换裁出对应图块。
   */
  drawMesh(attachment, slot, world, img, toScreen) {
    const ctx = this.ctx;
    const skeleton = this.skeleton;

    const verts = attachment.vertices;   // 静止姿势顶点，相对骨骼原点、Y 向上
    const uvs = attachment.uvs;          // 归一化 UV，左上原点
    const tris = attachment.triangles;

    // 预计算每根影响骨骼的「静止 → 当前」变换。
    //
    // 静止基准必须取世界坐标：bone.x/bone.y 是相对父骨骼的偏移，
    // 拿它当 restWorld 会让子骨骼少掉整条父链的位移。
    const restWorld = this.restWorld();
    const boneDelta = new Map();
    for (const name of new Set(attachment.bones.flat())) {
      const rest = restWorld.get(name);
      const cur = world.get(name);
      if (!rest || !cur) continue;
      boneDelta.set(name, { rest, cur });
    }

    // 附件顶点是相对「所属槽位骨骼」原点存的，先要能还原到世界静止位置
    const restSlot = restWorld.get(slot.bone) ?? { x: 0, y: 0, rot: 0 };
    const slotRad = (restSlot.rot * Math.PI) / 180;
    const slotCos = Math.cos(slotRad);
    const slotSin = Math.sin(slotRad);

    // 算出每个顶点蒙皮后的世界坐标。
    //
    // 加权网格的语义是：每根影响骨骼各自持有一份「该骨骼空间下」的顶点坐标，
    // 世界位置 = Σ 权重 × (该骨骼当前世界变换 × 它那份局部坐标)。
    // 之前直接把相对自身骨骼的坐标喂给父骨骼的变换，两边基准不一致，
    // 静止姿势就已经错位——表现就是部件拼不回原图、画面盖不满。
    const offX = attachment.x ?? 0;
    const offY = attachment.y ?? 0;

    const skinned = [];
    for (let v = 0; v < verts.length / 2; v++) {
      const vx = verts[v * 2] + offX;
      const vy = verts[v * 2 + 1] + offY;
      // 顶点的静止世界坐标
      const restX = restSlot.x + vx * slotCos - vy * slotSin;
      const restY = restSlot.y + vx * slotSin + vy * slotCos;
      const boneNames = attachment.bones[v];
      const weights = attachment.weights[v];

      let wx = 0;
      let wy = 0;

      for (let i = 0; i < boneNames.length; i++) {
        const w = weights[i];
        if (!w) continue;

        const d = boneDelta.get(boneNames[i]);
        if (!d) continue;

        // 顶点在这根骨骼静止空间下的坐标
        const rr = (-(d.rest.rot ?? 0) * Math.PI) / 180;
        const rcos = Math.cos(rr);
        const rsin = Math.sin(rr);
        const dx = restX - d.rest.x;
        const dy = restY - d.rest.y;
        const bx = dx * rcos - dy * rsin;
        const by = dx * rsin + dy * rcos;

        // 再套上这根骨骼的当前世界变换
        const cr = ((d.cur.rot ?? 0) * Math.PI) / 180;
        const ccos = Math.cos(cr);
        const csin = Math.sin(cr);

        wx += w * (d.cur.x + bx * ccos - by * csin);
        wy += w * (d.cur.y + bx * csin + by * ccos);
      }

      const sp = toScreen(wx, wy);
      skinned.push(sp.x, sp.y);
    }

    // 纹理来源：预先画到离屏 canvas，后续按 UV 裁切
    if (!this._imgCanvas || this._imgCanvasSrc !== img.src) {
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      c.getContext('2d').drawImage(img, 0, 0);
      this._imgCanvas = c;
      this._imgCanvasSrc = img.src;
    }

    // 逐三角形贴图
    for (let t = 0; t < tris.length; t += 3) {
      const i0 = tris[t];
      const i1 = tris[t + 1];
      const i2 = tris[t + 2];

      // UV 空间坐标（纹理像素）
      const u0 = uvs[i0 * 2] * img.width;
      const v0 = uvs[i0 * 2 + 1] * img.height;
      const u1 = uvs[i1 * 2] * img.width;
      const v1 = uvs[i1 * 2 + 1] * img.height;
      const u2 = uvs[i2 * 2] * img.width;
      const v2 = uvs[i2 * 2 + 1] * img.height;

      const denom = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0);
      if (Math.abs(denom) < 1e-6) continue; // 退化三角形，跳过

      // 屏幕空间坐标
      const x0 = skinned[i0 * 2];
      const y0 = skinned[i0 * 2 + 1];
      const x1 = skinned[i1 * 2];
      const y1 = skinned[i1 * 2 + 1];
      const x2 = skinned[i2 * 2];
      const y2 = skinned[i2 * 2 + 1];

      // 解仿射矩阵，把屏幕三角形映射回纹理空间
      const a = ((x1 - x0) * (v2 - v0) - (x2 - x0) * (v1 - v0)) / denom;
      const b = ((x2 - x0) * (u1 - u0) - (x1 - x0) * (u2 - u0)) / denom;
      const c2 = x0 - a * u0 - b * v0;
      const d = ((y1 - y0) * (v2 - v0) - (y2 - y0) * (v1 - v0)) / denom;
      const e = ((y2 - y0) * (u1 - u0) - (y1 - y0) * (u2 - u0)) / denom;
      const f = y0 - d * u0 - e * v0;

      ctx.save();

      // 裁剪到目标三角形，避免相邻三角形的纹理互相溢出
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.closePath();
      ctx.clip();

      ctx.transform(a, d, b, e, c2, f);
      ctx.drawImage(this._imgCanvas, 0, 0);
      ctx.restore();
    }

    // 线框叠加：三角剖分和形变直接可见。
    // 权重给错时表现为个别三角形被拉飞，光看贴图只觉得"糊了"，看线框才定位得到。
    if (this.showWireframe) {
      ctx.save();
      ctx.strokeStyle = 'rgba(52,211,153,0.7)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let t = 0; t < tris.length; t += 3) {
        const i0 = tris[t] * 2;
        const i1 = tris[t + 1] * 2;
        const i2 = tris[t + 2] * 2;
        ctx.moveTo(skinned[i0], skinned[i0 + 1]);
        ctx.lineTo(skinned[i1], skinned[i1 + 1]);
        ctx.lineTo(skinned[i2], skinned[i2 + 1]);
        ctx.closePath();
      }
      ctx.stroke();
      ctx.restore();
    }
  }
}
