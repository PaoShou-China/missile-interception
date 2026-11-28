# 2000 km 级高超声速拦截器仿真系统 —— 技术总结报告

> 版本：2026-11-28（高对抗物理闭环 + 3D 物理场可视化终极版）  
> 代码基线：`missile_intercept/`（Python + Numba fastcore） + `aerospace-vision-web/` + `interceptor-vision/`  
> 适用读者：需要复现、审查或扩展本仿真模型的工程与研究人员

---

## 摘要

本报告对仓库中的拦截器六自由度仿真系统做完整技术复盘，逐章说明**每个子系统使用了什么数据、采用了什么算法、公式如何实现**，并给出参数取值、数值方法、验证结论与已有仿真结果。系统以 WGS84 地球模型、USSA1976 大气、USAF Digital DATCOM 气动数据、固体助推（含 13 s 级间分离质量/质心/惯量阶跃）+ 超燃冲压组合动力（含进气道总压恢复系数 $\eta_{\text{inlet}}(\alpha,\beta,M)$ 与 Unstart 滞回判定、热–动压联合走廊节流）、一维瞬态薄壁气动热传导头罩、捷联机体系比力 GNSS/INS 组合导航、360° 隐身 RCS + X 波段脉冲多普勒/MWIR 双模抗诱饵导引头、CV+CA+3D-CT 三模型交互多模型滤波（IMM）、三轴独立增益调度/对称 BTT 三回路自动驾驶仪 + 32 Hz 二阶铰链力矩机电舵机 + 尾舵 NMP 预测补偿 + 定向破片近炸引信模型和 RK4 定步长积分为核心，覆盖"冷发射—助推分离—中制导走廊—交接—末段对抗拦截"全弹道。

2026-11-28 终极升级后的最新实测验证结果（详见文末第 15 节与 `output/validation/validation_report.txt`）：

- **标称单发弹道（152 列全量遥测）**：脱靶量 **`7.83 m`** @ `t = 679.775 s`（残余燃料 `119.6 kg`）；峰值动压经热–动压联合走廊从 `857.9 kPa` 压降至 **`652.9 kPa`（-23.9%）**，峰值驻点热流从 `8.60 MW/m²` 降至 **`5.77 MW/m²`（-32.9%）**，瞬态鼻锥壁温峰值 **`2342.0 K`**（辐射平衡峰值 `2377.7 K`，呈现真实热容滞后）；定向破片近炸引信提前量 **`3.56 ms`**（提前起爆 `9.2 m`，破片面密度 `6.08 /m²`，定向破片毁伤概率 **$P_k = 69.7\%$** vs Carleton $65.5\%$）；巡航段 IMM 概率 `[CV 79.3%, CA 10.5%, 3D-CT 10.2%]`，末段 9 g 机动与 414 帧红外诱饵/雷达箔条对抗下自适应切换至 `[CV 5.3%, CA 84.0%, 3D-CT 10.7%]` 且全部诱饵由波门剔除；
- **48 算例全包线性能验证矩阵**：在叠加上述全部高对抗真实物理约束后，通过率仍由基线 44/48（91.7%）进一步提升至 **OVERALL PASS — 46/48（95.8%，6/6 套件全部 PASS）**：A 组标称 **100.0%（均值 4.45 m，最大 6.39 m）**、B 组高度 **87.5%（均值 8.16 m）**、C 组速度 **100.0%（10/10，最大 14.29 m）**、D 组机动 **100.0%（8/8，9 g 均值 6.48 m）**、E 组几何 **100.0%（10/10，最大 13.07 m）**、F 组综合压力 **87.5%（7/8）**，48/48 全部稳定进入末制导；
- **消融误差预算（`tools/miss_budget.py --quick`）**：`nominal truth_nav` **`0.122 m`**、`no_sensor_noise` **`0.474 m`**、`alt-5km full` **`2.444 m`**；
- **全仓库自动化测试与三端构建**：仿真核心 `pytest` **98 项全通**（含纯 Python / Numba `fastcore.py` 二阶舵机高动压饱和、级间分离与 Unstart `1e-12` 同构测试）、根级溯源 `tests/` **48 项全通**、`aerospace-vision-web` Vitest **66 项全通**、载荷适配器与 `verify_scenario.py` **11/11 PASS**、`interceptor-vision` 气动 **28/28** 与 WGS84+USSA1976 6DOF **12/12** 全通，两端生产构建零错误。

> 注：下文中第 14 章保留的历史单发与旧版 100 发数据记录供前后对比审计；最新升级项与实测数据已汇总于文末第 15 节修订说明。

---

## 1 系统组成与代码结构

| 层 | 模块 | 职责 |
|---|---|---|
| 配置与数据契约 | `config.py` | 全部常数、气动表、场景与状态数据类 |
| 飞行器 | `vehicle/missile.py` | 气动、推进、力/力矩、14 状态导数 |
| 环境 | `vehicle/atmosphere.py`、`wind.py` | 大气、风与湍流 |
| 目标 | `vehicle/target.py` | F-35A 点质量模型与防御机动 |
| 传感器 | `sensors/imu.py`、`navigation.py`、`seeker.py`、`target_tracker.py` | 陀螺/加计、GNSS/INS、导引头、目标跟踪 |
| 制导 | `guidance/boost_guidance.py`、`midcourse_guidance.py`、`terminal_guidance.py`、`handover_manager.py` | 三段制导与交接管理 |
| 控制 | `control/autopilot.py`、`fin_mixer.py`、`thrust_controller.py` | 三回路 AP、舵混控、推力控制 |
| 数值 | `integrator.py`、`main.py` | RK4、事件检测、多速率调度 |
| 分析 | `batch.py`、`analysis.py`、`verification.py`、`validate_performance.py` | 蒙特卡洛、Sobol、数值验证、性能矩阵 |
| 加速 | `fastcore.py` | 与 Python 同构的 Numba 实现 |

数据流为单向：`config → vehicle/sensors → guidance → control → integrator`，采样数据模块在每个外步开始时以零阶保持（ZOH）冻结，RK4 内部不再采样（`main.py` 文件头注释）。

---

## 2 坐标系、状态与地球模型

### 2.1 状态向量

积分状态为 14 维（`state_schema.py`）：

$$
\mathbf{y}=\big[\underbrace{\mathbf r}_{3},\ \underbrace{\mathbf v}_{3},\ \underbrace{\mathbf q}_{4},\ \underbrace{\boldsymbol\omega_b}_{3},\ \underbrace{m}_{1}\big]^{T}
$$

- $\mathbf r,\mathbf v$：ECI 位置/速度（m、m/s）；
- $\mathbf q=[q_0,q_1,q_2,q_3]$：机体→ECI 四元数，标量在前；
- $\boldsymbol\omega_b=[p,q,r]^T$：机体角速度（rad/s）；
- $m$：质量（kg）。

目标为 6 状态 $[\mathbf r_t,\mathbf v_t]$；导航输出为 $\{\mathbf r,\mathbf v,t\}$；导引头量测为 $\{\mathbf u_{LOS},\boldsymbol\omega_{LOS},R,\dot R,\theta_{FOV}\}$。

### 2.2 地球模型

采用 WGS84 椭球（`EARTH_MODEL="wgs84"`）：

$$
a=6378137\ \text{m},\quad f=1/298.257223563,\quad b=a(1-f),\quad e^2=f(2-f)
$$

重力为中心场 + J2 摄动（`math_utils.gravity_eci`）：

$$
\mathbf g(\mathbf r)=-\frac{\mu}{r^3}\mathbf r+\mathbf k
$$

$$
\mathbf k=-\frac{3}{2}J_2\mu\frac{a^2}{r^5}
\begin{bmatrix}
r_x\left(1-\dfrac{5z^2}{r^2}\right)\\
r_y\left(1-\dfrac{5z^2}{r^2}\right)\\
r_z\left(3-\dfrac{5z^2}{r^2}\right)
\end{bmatrix},
\quad J_2=1.08262668\times10^{-3}
$$

$$
\mu=3.986004418\times10^{14}\ \text{m}^3/\text{s}^2,\quad \omega_\oplus=7.2921150\times10^{-5}\ \text{rad/s}
$$

局部"天"方向取**大地法线**（`math_utils.local_up`），而非径向，避免 28–40° 纬度下约 0.19° 的差异在长中制导段累积成公里级高度漂移。高度为大地高（`altitude()`）。

大气相对速度（风、马赫数与动压都用它）：

$$
\mathbf v_{air}=\mathbf v-\boldsymbol\omega_\oplus\times\mathbf r-\mathbf w
$$

---

## 3 大气与风

### 3.1 USSA1976 分层模型（数据）

`vehicle/atmosphere.py` 使用 0–86 km 的 8 层分段线性温度表（层底高度 m、层底温度 K、温度梯度 K/m）：

| 层底高度 | $T_b$ (K) | 梯度 (K/m) |
|---|---|---|
| 0 | 288.15 | −0.0065 |
| 11 000 | 216.65 | 0 |
| 20 000 | 216.65 | +0.0010 |
| 32 000 | 228.65 | +0.0028 |
| 47 000 | 270.65 | 0 |
| 51 000 | 270.65 | −0.0028 |
| 71 000 | 214.65 | −0.0020 |
| 84 852 | 186.946 | 0 |

层内：

$$
T(h)=T_b+L(h-h_b)
$$

$$
p(h)=
\begin{cases}
p_b\exp\left[-\dfrac{g_0(h-h_b)}{R T_b}\right], & L=0\\[6pt]
p_b\left(\dfrac{T(h)}{T_b}\right)^{-g_0/(R L)}, & L\neq0
\end{cases}
$$

$$
\rho=\frac{p}{R_{air}T},\qquad a=\sqrt{\gamma R_{air}T}
$$

$$
R_{air}=287.05287\ \text{J/(kg·K)},\quad \gamma=1.4,\quad g_0=9.80665\ \text{m/s}^2
$$

86 km 以上接等温指数尾：

$$
p=p_{86}\exp\left(-\frac{h-86000}{H}\right),\quad \rho=\rho_{86}\exp\left(-\frac{h-86000}{H}\right),\quad H=6000\ \text{m}
$$

尾段在 86 km 处与表值严格衔接（`_P86/_RHO86`），高度裁剪到 0–200 km，非有限值或非正值直接抛异常。

### 3.2 风与湍流

`vehicle/wind.py`：平均风定义在局部 ENU，速度遵循幂律切变

$$
V_w(h)=V_{ref}\left(\frac{h}{h_{ref}}\right)^{0.14},\quad V_{ref}=15\ \text{m/s},\ h_{ref}=10\ \text{km}
$$

风向 75°；三轴湍流为一阶高斯–马尔可夫（等效 Dryden 简化）：

$$
\tau_w=\frac{\Delta t}{T_w},\quad
w_k=\phi w_{k-1}+\sqrt{1-\phi^2}\,\sigma\,\xi_k,\quad \phi=e^{-\Delta t/T_w}
$$

$$
\sigma_h=1.5\ \text{m/s},\quad \sigma_v=0.8\ \text{m/s},\quad T_w=2\ \text{s}
$$

风矢量每个外步采样一次并 ZOH，转到 ECI 后叠加到 $\mathbf v_{air}$。

---

## 4 气动模型

### 4.1 数据来源

- 参考面积 $S_{ref}=\pi D^2/4=0.3117\ \text{m}^2$；
- $M\le5$：USAF Digital DATCOM（Jan 96）对"旋成体 + 十字舵"布局的计算结果，由 `tools/datcom_aero.py` 生成 `output/datcom_aero.csv`；
- DATCOM 计算网格：$M=[0.20,0.50,0.80,0.95,1.05,1.20,2.00,3.00,4.00,5.00]$，$\alpha=[0,2,4,6,8,12,16,20,24]^\circ$（10×9）；
- 运行时表在 `config.py` 中（15 个马赫点、9 个攻角点），含转声速桥接与 $M>5$ 高超声速分支；
- $M>5$：修正牛顿法（激波—膨胀波趋势），不直接外推表值。

### 4.2 法向力与升力线

$$
C_N = C_N^{\alpha}(M)\,\alpha\,S_\alpha(\alpha) + \Delta C_N^{Newton} + \tfrac14\delta_{pe}
$$

其中 $S_\alpha$ 为 DATCOM 拟合的攻角形状因子（0°→1.0，24°→2.12），$\delta_{pe}$ 为舵面有效偏度。牛顿分支在马赫 5–7 间按权重 $w_m$ 并入：

$$
C_N^{Newt}=C_{N,shape}\,C_{p,max}(M)\sin^2\alpha\cos\alpha
$$

$$
C_{p,max}(M)=\frac{2}{\gamma M^2}\left(\frac{p_{02}}{p_1}-1\right),\quad
\frac{p_{02}}{p_1}=\left[\frac{(\gamma+1)^2M^2}{4\gamma M^2-2(\gamma-1)}\right]^{\gamma/(\gamma-1)}\frac{1-\gamma+2\gamma M^2}{\gamma+1}
$$

$\gamma$ 由 1.40 线性降到 1.36（$M=10$），$C_{N,shape}=2.0$（无量纲升力体因子，量级与 $S_{planform}/S_{ref}\times0.41$ 一致）。

侧力与偏航：

$$
C_Y=C_Y^\beta(M)\beta+\tfrac14\delta_{ye},\qquad C_Y^\beta=-1.6\frac{C_N^\alpha-C_N^{body}}{10.17-C_N^{body}}
$$

$$
C_{N,yaw}=-C_N^\beta\beta+C_{N}^{\delta_r}\delta_{re}
$$

### 4.3 阻力

DATCOM 极曲线在速度系给出 $C_D=C_{D0}+kC_N^2$；求解器沿体系施加轴向力 $C_A$，故回转到体系：

$$
C_A=\frac{C_{D0}(M)+\Delta C_{D,f}(Re)+k(M)K_\alpha(\alpha)\left(C_N^2+C_Y^2\right)-C_N\sin\alpha}{\cos\alpha}
+\sum_{i\in\{p,y,r\}}C_{D,fin}\left(|\delta_i|+0.5\frac{\delta_i^2}{\delta_{max}}\right)
$$

其中 $K_\alpha$ 在大攻角由 1.0 降到 0.65。摩擦修正（DATCOM 表基于海平面雷诺数）：

$$
\Delta C_{D,f}=\mathrm{clip}\left[\left(\frac{0.074}{Re^{0.2}}-\frac{0.074}{Re_{ref}^{0.2}}\right)\frac{S_{wet}}{S_{ref}},\ -0.03,\ 0.20\right]
$$

$$
Re=\frac{\rho V L}{\mu(T)},\quad \mu(T)=\frac{1.458\times10^{-6}T^{1.5}}{T+110.4},\quad S_{wet}/S_{ref}=61
$$

$M>5$：$C_{D0}=C_{D0}(5)\cdot C_{p,max}(M)/C_{p,max}(5)$。

转声速桥接（DATCOM 在该区间无方法）：$M\in[0.5,1.6]$ 用单调桥，并对升力 −8%、阻力 +10% 取保守侧。

### 4.4 力矩、阻尼与舵效

$$
C_M=-\frac{\Delta x_{ac}}{L}C_{N,body}\,g_M(M,\alpha)+C_M^{\delta_e}(M)\delta_{pe}
$$

$$
\Delta x_{ac}(M,cg)=-\frac{C_M^{\alpha}(M)L}{C_N^{\alpha}(M)}+(x_{cg,full}-x_{cg}(t))
$$

$$
C_M^{\delta_e}(M)=-\frac{\left[C_N^\alpha(M)-2.0\right]\ell_{fin}}{L}
$$

$\ell_{fin}$ 由根弦、尖弦、半展、直径与四分之一弦后掠解析求得（`fin_lever()`），全弹状态约 1.08 m。$g_M$ 复现 DATCOM 大攻角力矩凸性。

阻尼项：

$$
C_m=C_M+C_{M_q}\hat q,\quad C_n=C_{N,yaw}+C_{N_r}\hat r,\quad C_l=C_L+C_{l_p}\hat p,\qquad
\hat p,\hat q,\hat r=\frac{p,q,r}{2V/L}
$$

$$
C_{M_q}=-25,\ C_{N_r}=-20,\ C_{l_p}=-0.90,\ C_{l_{\delta_a}}=0.27,\ C_{N}^{\delta_r}=0.30
$$

### 4.5 气动力与力矩

$$
\mathbf F_b=\begin{bmatrix}
-C_A q_\infty S+T+F_{base}\\
C_Y q_\infty S\\
-C_N q_\infty S
\end{bmatrix},\qquad
\mathbf M_b=\begin{bmatrix}C_l\\C_m\\C_n\end{bmatrix}q_\infty S L
$$

$$
\mathbf F_{ECI}=\mathbf R_{be}\mathbf F_b+m\mathbf g(\mathbf r),\qquad
F_{base}=0.020\,q_\infty S\ (T>0)
$$

舵面有效性非线性：$\delta_e=\delta\left[1-0.25(|\delta|/\delta_{max})^2\right]$。

---

## 5 推进与质量特性

### 5.1 固体助推（0–13 s）

$$
T(t)=F_{sl}\,s_T(t)+A_e\left(p_{sl}-p_a\right),\quad F_{sl}=130\ \text{kN},\ A_e=0.196\ \text{m}^2
$$

$s_T(t)$ 为归一化推力曲线（时间分数 0/0.1/0.8/0.9/1 → 0.85/1.02/1.02/1.00/0.90），点火瞬态与尾段收敛；平均约 1.003，保证总冲与 $I_{sp}$、恒质量流率一致。

$$
\dot m_b=\frac{m_{b,fuel}}{t_b}=\frac{800}{13}=61.54\ \text{kg/s},\qquad I_{sp}=215\ \text{s}
$$

（校核：$130000/(61.54\times9.80665)=215.4$ s）

### 5.2 超燃冲压（Ma 1.6–10）

$$
T=\min\left(\kappa\,q_\infty A_{in}\eta_M(M)\eta_h(h)\cos\alpha\cdot\theta,\ T_{max}\right)
$$

$$
\kappa=6,\quad A_{in}=0.22\ \text{m}^2,\quad T_{max}=60\ \text{kN}
$$

$$
\eta_M=
\begin{cases}
1, & M\le3\\
\max\left[1-0.05(M-3),\,0.55\right], & M>3
\end{cases}
$$

$$
\eta_h=
\begin{cases}
1, & h\le18\ \text{km}\\
1-\dfrac{h-18}{32-18}, & 18<h<32\ \text{km}\\
0, & h\ge32\ \text{km}
\end{cases}
$$

$$
\dot m_r=\min\left(\frac{T}{g_0 I_{sp,r}},\ 3.0\right),\quad I_{sp,r}=1500\ \text{s}
$$

油门 $\theta\in[0,1]$ 由推力控制器给出（第 11.5 节）。燃料耗尽、马赫/动压/高度越界或 $\theta=0$ 时进入 coast。

### 5.3 质量、惯量与质心

$$
m(t)=m_0-\int \dot m\,dt,\qquad f=\frac{m-m_{dry}}{m_0-m_{dry}}
$$

$$
I_{xx}=90+100f,\qquad I_{yy}=I_{zz}=2400+3600f\ \ (\text{kg·m}^2)
$$

$$
x_{cg}(m)=4.10+0.35f\ \text{m}
$$

（$m_0=2565$ kg，$m_{dry}=1000$ kg；质心随燃料消耗前移，使静稳定度增大，进入气动力矩与 AP 配平。）

---

## 6 六自由度运动方程

平动与转动（`Missile.derivatives`）：

$$
\dot{\mathbf r}=\mathbf v,\qquad
\dot{\mathbf v}=\frac{1}{m}\mathbf R_{be}\mathbf F_b+\mathbf g(\mathbf r)
$$

$$
\dot{\mathbf q}=\frac12\mathbf q\otimes[0,\boldsymbol\omega_b]^T
$$

$$
\mathbf I\dot{\boldsymbol\omega}_b=\mathbf M_b-\boldsymbol\omega_b\times(\mathbf I\boldsymbol\omega_b)-\dot{\mathbf I}\boldsymbol\omega_b
$$

$$
\dot m=-\dot m_p
$$

惯量随质量线性变化，故含 $\dot{\mathbf I}\boldsymbol\omega$ 项：

$$
\dot I_{ii}=-\frac{I_{ii,full}-I_{ii,dry}}{m_{fuel0}}\dot m_p
$$

攻角/侧滑由机体系速度分量给出：

$$
\alpha=\arctan\frac{w}{u},\qquad \beta=\arctan\frac{v_b}{\sqrt{u^2+w^2}}
$$

两者裁剪到 ±35°。

---

## 7 目标模型（F-35A）

### 7.1 场景数据

| 量 | 值 |
|---|---|
| 目标初始位置 | 28°N, 126°E, 15 240 m |
| 目标速度 | Ma 1.6（上限，模型裁剪） |
| 设计过载 | 9 g（B/C 型 7/7.5 g） |
| 机翼面积/展长 | 42.7 m² / 10.7 m |
| 质量 | 20 000 kg |
| $C_{L,max}$ | 1.2（亚声速）→0.8（Ma≥1.2 线性过渡） |
| 反应距离 | 60 km 防御转向，15 km 终端规避 |

### 7.2 可用过载

$$
n_{avail}=\frac{q_\infty S_w C_{L,max}(M)}{m_t g_0}
$$

在 15.24 km / Ma 1.6（$q\approx21$ kPa）只有约 2–3 g，规避指令取 $\min(n_{cmd},n_{avail})$。

### 7.3 分段机动

- **巡航（>60 km）**：沿大圆等高等速；向心加速度 $-v^2/r_n\,\mathbf u_{up}$。
- **防御（60–15 km）**：朝导弹方位的转弯 + 俯冲，转弯权限随波束角衰减：
$$
g_{turn}=\mathrm{clip}\left(\frac{\cos\theta-0.20}{0.80-0.20},0,1\right),\quad
n_{turn}=\min(n_{evade},6,n_{avail})\,g_{turn}
$$
俯冲在航迹角达到 −25° 时停止：$n_{desc}=\min(1,n_{avail})\,\mathrm{ramp}\,\cdot(n_{evade}/6)$，合成后按 $n_{avail}$ 等比缩放。
- **终端（<15 km）**：0.25 Hz 横向 + 0.5 Hz 垂向（幅值 25%）抖动，含一阶起始滞后 $\tau=0.6$ s 的稳态幅相修正：
$$
a_{man}=A\,|H(j\omega_1)|\sin(\omega_1 t-\phi_1+\phi_0)\,\mathbf e_\perp+
0.25A\,|H(j\omega_2)|\sin(\omega_2 t+1-\phi_2+\phi_0)(-\mathbf u_{up})
$$

机动代价：诱导阻力减速

$$
\Delta C_D=\frac{n^2 C_{L,trim}^2}{\pi\,AR\,e},\qquad
\mathbf a_{bleed}=-\frac{q_\infty S_w\Delta C_D}{m_t}\hat{\mathbf v}_{air}
$$

---

## 8 导航系统

### 8.1 惯性器件（数据来自 `config.py`）

| 参数 | 值 |
|---|---|
| 陀螺白噪声 $\sigma_g$ | $2\times10^{-4}$ rad/s |
| 陀螺初始零偏 | $2\times10^{-4}$ rad/s |
| 零偏稳定性（walk） | $2\times10^{-5}$ rad/s |
| 零偏相关时间 | 1000 s |
| 标度因数误差 | $2\times10^{-3}$ |
| 量化 | $1\times10^{-6}$ rad/s |
| 加计白噪声 | 0.012 m/s² |
| 加计零偏/稳定性 | 0.0147 / 0.0015 m/s² |
| 星敏（1 Hz） | $3.5\times10^{-4}$ rad |
| GNSS 位置/速度 | 8 m / 0.15 m/s（每轴 1σ） |

姿态由**实测陀螺角速率**传播，而非真值四元数；星敏提供绝对姿态修正，GNSS 速度只做小侧滑下的航向修正（$\beta<3^\circ$），修正时间常数 1 s、零偏积分增益 0.01。

### 8.2 12 状态 GNSS/INS 卡尔曼滤波

状态：

$$
\mathbf x=[\mathbf r,\mathbf v,\mathbf b_a,\mathbf b_g]^T\in\mathbb R^{12}
$$

预测（每 5 ms）：

$$
\mathbf r^-=\mathbf r+\Delta t\,\mathbf v+\tfrac12\Delta t^2(\mathbf a_{meas}-\mathbf b_a),\quad
\mathbf v^-=\mathbf v+\Delta t(\mathbf a_{meas}-\mathbf b_a)
$$

$$
\mathbf b_a^-=\phi_a\mathbf b_a,\quad \mathbf b_g^-=\phi_g\mathbf b_g,\quad
\phi=e^{-\Delta t/\tau}
$$

$$
\mathbf P^-=\mathbf F\mathbf P\mathbf F^T+\mathbf Q,\qquad
\mathbf F=\begin{bmatrix}
I&\Delta t I&-\tfrac12\Delta t^2I&0\\
0&I&-\Delta t I&0\\
0&0&\phi_a I&0\\
0&0&0&\phi_g I
\end{bmatrix}
$$

GNSS 更新（1 Hz，$H=[I_6\ 0]$）：

$$
\mathbf K=\mathbf P H^T\left(H\mathbf P H^T+\mathbf R\right)^{-1},\quad
\mathbf R=\mathrm{diag}(\sigma_p^2 I_3,\sigma_v^2 I_3)
$$

输出经 50 ms 历史缓冲延迟，模拟处理/链路时延；终端制导再按指令+重力外推回当前时刻。

---

## 9 导引头与目标跟踪

### 9.1 双模探测

- 雷达通道按 RCS 的 1/4 次方定标：

$$
R_{radar}=45\ \text{km}\left(\frac{\sigma}{5\ \text{m}^2}\right)^{1/4}
$$

对 F-35 前向 $\sigma=0.005\ \text{m}^2$（−23 dBsm）→ **约 8 km**；
- IIR 通道与 RCS 无关，**25 km**；双模取较远者作为锁定距离（`Seeker.__init__`）。

Swerling-I：每次扫描 RCS 服从均值为 $\sigma$ 的指数分布：

$$
\sigma_{scan}=\sigma\,(-\ln u),\quad u\sim U(0,1)
$$

### 9.2 量测噪声

$$
\sigma_{glint}=0.30\frac{L_t}{R},\qquad
\sigma_\theta=\sqrt{(1\ \text{mrad})^2+\sigma_{glint}^2}
$$

距离/距离率噪声 5 m / 2 m·s⁻¹；视线角一阶平滑 30 ms；视场 ±20°，盲区 120 m。

丢失/虚警为泊松事件：丢锁率 0.05 /s，虚警率 0.01 /s；虚警需连续 3 次确认，且报告视线被旋转 $0.35\,\theta_{FOV}$（用于检验交接一致性门）。

### 9.3 目标跟踪（转换量测 KF）

状态 $[\mathbf r_t,\mathbf v_t]$，均值按等高飞行传播（含向心项），协方差用常速模型 + 白噪声加速度：

$$
\mathbf P^-=\mathbf F\mathbf P\mathbf F^T+\mathbf Q,\quad
Q=\sigma_a^2\begin{bmatrix}\Delta t^3/3&\Delta t^2/2\\\Delta t^2/2&\Delta t\end{bmatrix}
$$

量测：$\mathbf z=\mathbf r_m+R\,\mathbf u_{LOS}$，噪声

$$
\mathbf R_m=\sigma_R^2\,\mathbf u\mathbf u^T+(R\sigma_\theta)^2(I-\mathbf u\mathbf u^T)
$$

更新用 Joseph 形式保证半正定：

$$
\mathbf P=(\mathbf I-\mathbf KH)\mathbf P(\mathbf I-\mathbf KH)^T+\mathbf KR_mK^T
$$

---

## 10 制导律

### 10.1 助推段（重力转弯）

冷发射垂直上升 2 s 后进入俯仰程序。程序角速率受**可用法向过载**限制：

$$
a_{feasible}=0.85\left(\frac{q_\infty S C_N^\alpha\alpha_{max}}{m}+\frac{T\sin\alpha_{max}}{m}\right)
$$

$$
\dot\gamma_{ref}=-\min\left(8^\circ/\text{s},\ \frac{a_{feasible}}{V}\right),\qquad
\gamma_{ref}\ge\gamma_{hand}=30^\circ
$$

指令：

$$
a_\perp=V\left(\dot\gamma_{ref}+1.2(\gamma_{ref}-\gamma)\right)+g_0\cos\gamma
$$

$$
a_{head}=0.8\,V\,\varepsilon_{head}
$$

两者按可用过载缩放，再除以 $1+T/(q_\infty S C_N^\alpha)$ 扣除推力法向分量（避免重复计数），限幅 4 g；高度 <500 m 附加 1.5 g 拉起。

助推→中制导门限：$t\ge20$ s 或（$V>1700$ m/s 且 $h>20$ km）。

**对比基线 `fixed_rate`（`guidance/fixed_rate_boost_guidance.py`）**：俯仰程序角速率固定为 3.5°/s，不查询动压/可用过载，也不重新分配横向指令；其余高度、推力、指令坐标系与可行性塑形版本共用。该基线用于隔离“可行性感知程序整形”的作用。

### 10.2 中制导

**路径**：三次 Bézier

$$
\mathbf B(s)=(1-s)^3\mathbf p_0+3(1-s)^2s\,\mathbf p_1+3(1-s)s^2\mathbf p_2+s^3\mathbf p_3
$$

$$
\mathbf B'(s)=3(1-s)^2(\mathbf p_1-\mathbf p_0)+6(1-s)s(\mathbf p_2-\mathbf p_1)+3s^2(\mathbf p_3-\mathbf p_2)
$$

$$
\mathbf B''(s)=6(1-s)(\mathbf p_2-2\mathbf p_1+\mathbf p_0)+6s(\mathbf p_3-2\mathbf p_2+\mathbf p_1)
$$

- $\mathbf p_0$：当前位置；$\mathbf p_1=\mathbf r+\ell\hat{\mathbf v}$，初始爬升角限制 10°；
- $\mathbf p_3$：预测交接点（目标未来位置 + 1000 m 高度优势）；
- $\mathbf p_2=\mathbf p_3-\ell\hat{\mathbf v}_{arr}$，到达速度指向目标；
- $\ell=\min(0.25TV,40\ \text{km})$，路径时长 $T=\mathrm{clip}(t_{go},30,900)$ s；
- 每 10 s 重规划，距目标 150 km 内冻结（防止曲线退化）。

**跟踪**（前视 30 km，PD + 曲率前馈）：

$$
\mathbf a_{bez}=k_1(\mathbf r_{ref}-\mathbf r)+k_2(\mathbf v_{ref}-\mathbf v)+\frac{\mathbf B''(s)}{T^2}
$$

$$
k_1=2\times10^{-4},\quad k_2=0.06,\quad \|\mathbf a_{ff}\|\le1.5g
$$

**PN 修正**：对持续预测的交接点 $\mathbf r_{pip}$：

$$
\boldsymbol\omega=\frac{\boldsymbol\rho\times\mathbf v_{rel}}{R_{pip}^2},\qquad
\mathbf a_{PN}=N\,V_c\,\boldsymbol\omega\times\hat{\boldsymbol\rho},\quad N=2(1+0.5\kappa_{lead})
$$

**能量管理**：巡航段保持 $q^*=75$ kPa（约 30 km、$\alpha\approx6^\circ$）：

$$
\gamma_{des}=\mathrm{clip}\left(0.45\left(\frac{q_\infty}{q^*}-1\right),-0.08,0.08\right)
$$

$$
a_{vert}=\mathrm{clip}\left[\tfrac12V(\gamma_{des}-\gamma)-0.22(v_{z}-v_{z,ref}),\ -a_{max},a_{max}\right]+g_0\cos\gamma
$$

下压段由"需要消除的高度差"反推入场距离 $R_{entry}=(dh+1500-1000)/(0.35\tan9^\circ)$，再用三次 Hermite 升力体剖面（loft 1500 m，顶点 70%）生成 $\gamma_{ff}$，按 $a_{n}=-(6x+4\dot x t_{go})/t_{go}^2$ 控制共面通道（增益 0.8、$t_{go}\ge8$ s、限幅 3 g）。

**角度约束与终端误差预反馈**：

$$
a=-k\,w\,\frac{V}{t_h}(\gamma-\gamma_{ref}),\qquad
\mathbf a_{pred}=-0.2\cdot2w\frac{\mathbf{ZEM}_\perp}{t_h^2}
$$

末段总指令限幅 5 g；重规划后 2 s 交叉淡入。

**对比律 `pip_pn`（`guidance/pip_midcourse_guidance.py`）**：以当前估计的目标状态外推预测拦截点（PIP），直接对 PIP 施加比例导引与高度保持，不再使用三次 Bézier 塑形。它保留同一交接管理器、同一过载限幅与同一姿态控制，用于隔离中制导塑形策略。

### 10.3 交接管理

十项门限（全部满足并保持 0.2 s）：

| 门 | 阈值 |
|---|---|
| 距离 | ≤24 km（强制交接 ≤20 km） |
| 视场 | ≤0.9×20° |
| 前置角 | ≤12° |
| 剩余时间 | ≥4 s |
| 可用过载 | ≥4 g |
| 高度差 | $0\le dh\le\max(12\ \text{km},\,R\tan22^\circ)$ |
| 速度 | ≥1800 m/s |
| 导引头 | 锁定且确认 |
| 一致性 | LOS 偏差 ≤5°，距离偏差 ≤25% |

强制交接放宽几何/高度门，但保留时间、过载、锁定与一致性检查。触发后 0.5 s 内从中制导指令线性过渡到末制导。

### 10.4 末制导（ZEM/APN）

$$
t_{go}=\max\left(\frac{R}{V_c},0.05\right),\quad V_c=\max(-\dot R,50)
$$

$$
\mathbf{ZEM}=\boldsymbol\rho+\mathbf v_{rel}t_{go}+\tfrac12\mathbf a_Tt_{go}^2
$$

$$
\mathbf a=N_{eff}\frac{\mathbf{ZEM}_\perp}{t_{go}^2}-\mathbf g_\perp
$$

$$
N_{eff}=\max\left[3,\ N\left(1+0.4\,\mathrm{clip}\left(1-\frac{t_{go}}{20},0,1\right)\right)\right]
$$

目标加速度由跟踪速度差分 + 一阶低通（0.25 s），限幅 9 g。视场保护在预测越界时叠加 $\min[2(1+e)V_c,4g]$ 的法向修正；指令一阶平滑 0.75，最终限幅 **20 g**（`config.MAX_LOAD_G`，全阶段统一结构限制）。导引头视场内的新视线与跟踪器一致性通过时（误差 ≤max(500 m, 20%R)），用导引头距离/距离率直接修正相对几何。

---

## 11 控制系统

### 11.1 三回路结构

外环（伪攻角）→ 中环（角速率）→ 内环（舵面），带前馈与积分：

$$
q_{cmd}=\dot\alpha_{ref}+K_P^\alpha e_\alpha+K_I^\alpha\!\int e_\alpha
+n_z\text{ 修正}
$$

$$
\delta_p=-K_P^q\,e_q-K_I^q\!\int e_q+\delta_{trim}
$$

$$
\delta_r=K_P^p\,e_p+K_I^p\!\int e_p
$$

$$
K_P^\alpha=6.0,\quad K_P^q=0.14,\quad K_P^p=0.035,\quad K_I^p=0.008
$$

**对比基线 `classic_pid`（`control/classic_autopilot.py`）**：固定增益、固定 5 Hz 预滤波，关闭动压增益调度、参考指令整形、死区时间预测与 $n_z$ 回路；内回路增益、抗积分饱和与舵面限幅与基准一致。该实现走纯 Python 控制路径，不修改 Numba 参考路径，因此对比隔离的是“调度/整形/延迟补偿”架构本身。

### 11.2 增益调度

速率环增益按瞬时"被控对象"归一，使穿越频率固定为 $\omega_q=22$ rad/s：

$$
K_{scale}=\mathrm{clip}\left[\frac{\omega_q I_{yy}}{q_\infty S L\,|C_M^{\delta_e}|\,K_P^q},\ 0.3,\ 3.0\right]
$$

$$
|C_M^{\delta_e}|=\frac{(C_N^\alpha-2.0)\ell_{fin}}{L}
$$

预滤波带宽 $f=f_0\sqrt{q/q_{ref}}$（偏航再乘 $\sqrt{|C_M^{\delta_r}|/|C_M^{\delta_e}|}$）；参考角速率上限随 $\sqrt{q}$ 缩放；积分在 $q<100$ Pa 或饱和时冻结，并按 $\sqrt{q/q_{ref}}$ 降权。

### 11.3 直接法向过载环

$$
n_{cmd}=-\frac{a_{b,z}}{g_0},\qquad
n_{used}=n_{meas}+0.06\,\dot n_{meas}\ (\text{LPF }0.02\ \text{s})
$$

$$
q_{cmd}\mathrel{+}=0.02\,e_n+0.004\!\int e_n
$$

### 11.4 舵混控与执行机构

虚拟指令 $[\delta_P,\delta_Y,\delta_R]$ → 四片物理舵（上/下/左/右）：

$$
\begin{bmatrix}\delta_{up}\\\delta_{down}\\\delta_{left}\\\delta_{right}\end{bmatrix}
=\begin{bmatrix}0&1&0\\0&1&0\\1&0&-1\\1&0&1\end{bmatrix}
\begin{bmatrix}\delta_P\\\delta_Y\\\delta_R\end{bmatrix}
$$

速率限幅 150°/s、一阶滞后 10 ms、位置限幅 ±25°；饱和标志回送 AP 冻结积分。

### 11.5 推力控制

- 助推：$\theta=1$；
- 末制导：包线内 $\theta=1$；
- 中制导：马赫保持比例律

$$
\theta_{target}=\mathrm{clip}\left[0.8(M_{ref}-M),0,1\right],\quad M_{ref}=9.5
$$

再经 0.25 s 一阶燃油滞后与 1.5 /s 速率限幅。

---

## 12 仿真框架与数值方法

### 12.1 多速率调度（ZOH）

| 模块 | 周期 |
|---|---|
| 导引头 / 自动驾驶 / 制导 | 5 ms |
| GNSS | 1 s（输出延迟 50 ms） |
| 星敏 | 1 s |
| 遥测 | 10 ms |

每个外步开始时统一采样并冻结，RK4 的 4 个级内不再调用采样模块，保证确定性与事件重积分无副作用。

### 12.2 积分器

经典四阶 Runge–Kutta：

$$
\mathbf y_{n+1}=\mathbf y_n+\frac{h}{6}(\mathbf k_1+2\mathbf k_2+2\mathbf k_3+\mathbf k_4)
$$

$$
\mathbf k_1=f(t_n,\mathbf y_n),\quad
\mathbf k_2=f(t_n+\tfrac h2,\mathbf y_n+\tfrac h2\mathbf k_1),\quad
\mathbf k_3=f(t_n+\tfrac h2,\mathbf y_n+\tfrac h2\mathbf k_2),\quad
\mathbf k_4=f(t_n+h,\mathbf y_n+h\mathbf k_3)
$$

步长：助推/末制导 5 ms，中制导 10 ms（准稳态巡航）。

事件（最近点脱靶、落地）用方向感知符号变化检测，再在步内二分并用 RK4 从左端重构状态（时间容差 $10^{-10}$），避免端点 Hermite 插值在推力/舵面跳变处产生 $O(h^4)$ 误差。

另提供 Cash–Karp RK4(5) 自适应参考积分器（仅连续动力学），误差按 $atol+rtol\max(|y|,|y_{new}|)$ 归一，步长因子 $\mathrm{clip}(0.9\,\epsilon^{-0.2},0.2,5)$。

### 12.3 阶段状态机

`boost → midcourse → terminal`：助推 20 s 或速度/高度门限；中制导经交接门阵列触发后进入末制导；脱靶/落地事件终止。

---

## 13 不确定性、灵敏度与验证

### 13.1 蒙特卡洛抽样（`batch.py`）

二维圆概率误差转每轴标准差：

$$
\sigma=\frac{CEP}{\sqrt{2\ln2}}
$$

默认散布：发射点 CEP 500 m、目标 CEP 2000 m、目标高度 $\sigma=500$ m、马赫 $\sigma=0.05$、规避过载 $\sigma=1$ g、规避相位 $U(0,2\pi)$。每例独立随机种子 $s_i=s_0+7919i$。

### 13.2 Sobol 灵敏度（Saltelli/Jansen）

$$
S_i=\frac{\frac1N\sum_{j=1}^N f_B^{(j)}\left[f_{AB_i}^{(j)}-f_A^{(j)}\right]}{\mathrm{Var}(f)}
$$

$$
S_{T_i}=\frac{\frac1{2N}\sum_{j=1}^N\left[f_A^{(j)}-f_{AB_i}^{(j)}\right]^2}{\mathrm{Var}(f)}
$$

采样用 Scrambled Sobol 序列，目标函数可选原始脱靶量、对数脱靶量或命中指示。

### 13.3 数值验证

| 用例 | 判据 | 结果 |
|---|---|---|
| RK4 收敛阶（$y'=y$） | 观测阶 ≥3.8 | 通过 |
| Kepler 圆轨道一周 | 半径/比能量相对误差 ≤1e−6 | 通过 |
| 四元数长期范数 | 投影后 $\|\mathbf q\|=1$ | 通过（83 项测试之一） |

`pytest` 全量运行：**83 passed in 39.4 s**。

### 13.4 性能验证矩阵（已有数据）

判据：单发脱靶 ≤15 m，组通过率 ≥80%。

| 组 | 内容 | 通过/总数 | 通过率 | 均值 (m) | 最大 (m) | 判定 |
|---|---|---|---|---|---|---|
| A | 基准交会 | 4/4 | 100% | 10.70 | 14.37 | PASS |
| B | 目标高度 5/8/12/15 km | 7/8 | 87.5% | 8.64 | 23.17 | PASS |
| C | 目标马赫 0.8–1.6 | 10/10 | 100% | 7.34 | 12.97 | PASS |
| D | 目标规避 0/3/6/9 g | 4/8 | 50.0% | 13.51 | 19.98 | FAIL |
| E | 交会几何（±200 km / ±150 km） | 7/10 | 70.0% | 16.11 | 44.29 | FAIL |
| F | 组合最恶劣 | 7/8 | 87.5% | 8.83 | 15.10 | PASS |

合计 39/48（81.2%），但 D、E 组低于 80%，验证脚本总体判定 FAIL。

---

## 14 结果数据

### 14.1 标称单发（`intercept-report/assets/metrics.json`）

| 指标 | 值 |
|---|---|
| 脱靶量 | 24.27 m |
| 拦截时间 | 676.46 s |
| 最大速度 / 马赫 | 3094.5 m/s / 9.48 |
| 最大动压 | 881.3 kPa |
| 最大过载 | 40.0 g（20 g 结构限制生效前的历史算例） |
| 最大高度 | 29.93 km |
| 燃料消耗 | 1424.4 kg |
| 射程（地面投影） | 1846.3 km |
| 交接时间/距离 | 668.79 s / 1824.9 km |
| 采样数 | 67 647（5 ms，降采样 900 点绘图） |

阶段：助推 0–20 s，中制导 20–668.79 s，末制导 668.79–676.46 s。

### 14.2 100 发蒙特卡洛（`output/batch/batch_results.csv`）

| 指标 | 值 |
|---|---|
| 平均 / 中位脱靶 | 10.36 m / 9.27 m |
| P90 / 最大脱靶 | 18.74 m / 34.90 m |
| 命中（≤15 m） | 79 / 100 |
| 仿真成功 | 100 / 100 |
| 平均交接距离 | 23.3 km |

### 14.3 配对对比实验（`docs/experiments/`）

配对蒙特卡洛使用同一 `case_id` 的发射点/目标点散布、高度/马赫散布、导航与导引头随机种子以及目标机动相位；同一 case 的两种算法只差被测环节。

| 实验 | 对比 | 扫描 | 结果文件 |
|---|---|---|---|
| 末制导 | 纯 PN vs ZEM/APN | 目标机动 0–8 g | `guidance_comparison/summary.json` |
| 中制导 | PIP vs Bezier | 目标机动 0–6 g | 同上 |
| 助推 | fixed_rate vs feasible | 目标高度 10–20 km | 同上 |
| 姿控 | classic_pid vs scheduled | 目标机动 0–8 g | 同上 |
| 整机架构 | 经典整套 vs 参考整套 | 0 g，24 例 | `architecture_comparison/summary.json` |

Web 端 `campaign.json` 固化的是 2026-11-21 的 4 例/律快速采集加 24 例架构组；重新运行离线脚本会更新 `docs/experiments`，但不会自动改写已发布的 Web 数据。所有新算例通过载荷完整性检查，但**未**完成独立科学验证，因此界面中的差值只作描述性展示。

### 14.4 气动数据文件

`output/datcom_aero.csv`（3.8 kB）保存 DATCOM 原始系数矩阵；运行时表在 `config.py` 第 5 节，便于审计与替换。

---

## 15 局限与改进方向

1. **高超声速气动**：$M>5$ 采用修正牛顿 + 激波膨胀趋势，缺少真实 CFD/风洞校验；转声速桥接为工程拟合，已用 −8% 升力 / +10% 阻力取保守侧。
2. **目标模型**：点质量 + 升力限幅 + 诱导阻力，未建模姿态/飞控延迟；防御战术为规则式，不是最优规避。
3. **导引头物理链路、末段对抗与三模型 IMM 跟踪**：`sensors/seeker.py` 建模姿态角相关隐身目标单站 RCS 极坐标（F-35A 级：前向 0.005 m² / -23 dBsm、前缘衍射瓣 36°/144°、侧向 0.18 m² / -7.4 dBsm、尾向 0.06 m² / -12.2 dBsm）、X 波段脉冲多普勒雷达 $R^{-4}$ 链路（含下视杂波与 ±35 m/s 零多普勒陷波）、MWIR（3.7–4.8 μm）被动红外 $R^{-2}$ 链路（蒙皮气动加热 + 姿态相关尾焰 + Beer-Lambert 大气透射率 + 蓝宝石窗口瞬态热透射衰减与热背景）；`vehicle/target.py::decoy_state` 在末段 14 km 9 g 规避期间周期抛射高气动阻力红外诱饵弹与雷达箔条云，导引头基于脉冲多普勒径向速差与双波段一致性门限实现抗诱饵关联剔除；`sensors/target_tracker.py` 采用标准 Blom–Bar-Shalom **CV + CA/Singer + 3D 协同转弯（Rodrigues 旋转 CT）三模型交互多模型滤波（IMM）**。
4. **一维瞬态热传导头罩、热–动压走廊、级间分离与进气道 Unstart**：`vehicle/missile.py::step_transient_wall_temp` 将稳态壁温升级为薄壁热容一维瞬态方程 $\rho_w c_p \delta_w \dot{T}_w = \dot{q}_w - \varepsilon\sigma(T_w^4 - T_\infty^4)$ 并实时耦合进蓝宝石窗口透射衰减；`midcourse_guidance.py` 与 `thrust_controller.py` 引入 $q_{\max}$–$\dot{q}_{\max}$ 联合走廊约束，将峰值动压由 `857.9 kPa` 压降至 `652.9 kPa`、峰值热流由 `8.60 MW/m²` 降至 `5.77 MW/m²`；13 s 助推燃尽点执行离散级间分离（抛离 95 kg 助推壳体并伴随质心/惯量阶跃）；超燃冲压进气道引入随 $(\alpha,\beta,M)$ 衰减的总压恢复系数及 $|\alpha_{\text{tot}}|>10^\circ / <7^\circ$ Unstart 滞回判定（`unstart_flag`），纯 Python 与 Numba `fastcore.py` 严格同构。
5. **二阶机电舵机、NMP 末段补偿、可选弹性模态与三维定向破片引信**：`control/fin_mixer.py` 与 `fastcore.py::fin_mixer_mix` 升级为 32 Hz / $\zeta=0.70$ 四子步二阶机电舵机，并加入 $q_\infty > 400\text{ kPa}$ 铰链力矩饱和折减；`guidance/terminal_guidance.py` 引入尾舵非最小相位（NMP）滞后 $\tau_{\text{nmp}} = 32\text{ ms}$ 有限时域预测超前补偿；`control/autopilot.py` 提供 `SimConfig.enable_flex_mode` 开关式 22 Hz 一阶弹体弯曲模态 + 双二阶陷波滤波器；`vehicle/warhead.py::proximity_fuze_lethality` 基于交会相对速度与弹体姿态计算 $2\text{–}5\text{ ms}$ 近炸引信起爆提前量与定向破片飞散环面密度，输出物理毁伤概率 $P_k$（标称 7.83 m 对应提前量 `3.56 ms`、提前 `9.2 m` 起爆、$P_k = 69.7\%$）。
6. **2026-11-28 三端 3D 物理场与深度洞察可视化总览**：
   - **3D GLSL 激波脱体锥 / 黑体辐射气动热与 X 光受力矢量模式**：`interceptor-vision/src/scene/AeroPhysicsOverlay.tsx` 与 `aerospace-vision-web/src/scene/AeroPhysicsField.tsx` 均新增一键切换（快捷键 `X`）的自定义 GLSL 随马赫数/攻角变化激波锥、普朗克黑体头罩发热着彩、升力/阻力/推力/尾舵 NMP 反向直接力 3D 矢量箭与动态 CG/CP 静稳定裕度标记；
   - **双模抗诱饵态势渲染 + B-Plane 脱靶归因瀑布图**：三端（`SeekerOverlay.tsx`、`SensorAnalyticsCards.tsx`、`visualization.py` 12 面板仪表盘）同步实时绘制红外诱饵与多普勒分离雷达箔条（`FLARE GATED` / `CHAFF REJECTED`）、IMM 三模型权重演化、瞬态/平衡壁温对比及联动 `tools/miss_budget.py` 的脱靶误差归因瀑布图；
   - **蒙特卡洛 3D 弹道束与交接点云**：`aerospace-vision-web` 的 `#/compare` 工作台（`CompareScene.tsx` / `ComparePage.tsx`）新增 `THREE.LineSegments` + 半透明包络管 + `THREE.InstancedMesh` 交接点云的 A/B 散布同屏对比；
   - **语义事件时间轴、0.1× 末段子弹时间与深度链接**：播放条自动标注 `BOOSTER SEP`、`MAX Q`、`INLET UNSTART`、`DECOY EJECT`、`INTERCEPT` 等可点击事件锚点，一键跳转并切入 `0.1×` 末段慢放，支持 `?t=...&view=...&compare=...` 深度链接一键分享。
   - **全仓库总回归结果**：`missile_intercept` 98/98 `pytest`、48 算例验证矩阵 **6/6 套件全部 PASS（46/48 = 95.8%）**、根级 `tests/` 48/48 PASS、`verify_scenario.py` 11/11 PASS、`aerospace-vision-web` 66/66 Vitest + 构建 PASS、`interceptor-vision` 28/28 气动 + 12/12 6DOF + 构建 PASS。
7. **实时性与对比实验声明**：Numba 快核与纯 Python 双路径严格同构（测试已覆盖 `1e-12` 级一致性）；`campaign.json` 仍为 2026-11-21 快速采集基线，仅作描述性对比展示。

---

## 16 可视化与实验配置平台（Aerospace Vision Web）

浏览器端为纯静态 React 19 + Vite + Three.js + ECharts，无后端。数据链为：

```
telemetry.csv → tools/data-adapter/build_scenario.py → scenario.json
              → 单一仿真时钟 → 3D / HUD / 图表 / 对比工作台
```

- **数据真实性**：所有位姿来自样本数组；目标姿态由 ECEF 速度推导并标注；不做高度或轨迹夸张。
- **视角**：轨道、追踪、拦截、近景四个。近景为机体系后侧三分之四构图，同时显示四片尾舵、尾喷口/羽流与体轴三轴。
- **环境**：WGS84 椭球、日间贴图 bump 地形、海面太阳高光、分层云、大气边缘；太阳/月亮/昼夜由声明历元与仿真时间驱动，不参与弹道解算。
- **实验配置工作台**（`#/compare`）：A/B 各四个下拉框（制导、姿控、飞行器、场景）；仅加载真实记录，缺失组合显示 `No Available Experiment`。可比性分为严格/部分/不可比；仅定义与条件一致时计算差值。
- **实验集统计**：命中率、中位/P90/均值/最大脱靶、交接距离与比能量、助推结束高度/马赫、舵面饱和率；数据来自 `public/data/experiments/campaign.json`，与单条代表轨迹分开标注。
- **响应式**：≤720 px 时面板单列、下拉框 14–15 px、按钮 ≥44 px、A/B 三维各 38–42 vh、宽表在区域内横向滚动；E2E 断言页面本身无横向溢出。
- **部署**：GitHub Pages，Vite 相对 base；旧报告保留原路径并另设 `/legacy/`。

平台的可运行性、单元测试、Chromium/WebKit E2E、性能与验收记录见
`aerospace-vision-web/docs/ACCEPTANCE.md`。

---

## 附录 A 主要参数速查

| 类别 | 参数 | 值 |
|---|---|---|
| 几何 | 长度 / 直径 / 参考面积 | 8.11 m / 0.63 m / 0.3117 m² |
| 翼面 | 根弦 / 尖弦 / 半展 | 3.8 / 1.6 / 0.364 m |
| 质量 | 发射 / 干重 / 固体燃料 | 2565 / 1000 / 800 kg |
| 惯量 | $I_{xx}$ / $I_{yy}=I_{zz}$ | 190→90 / 6000→2400 kg·m² |
| 质心 | 满载 / 干重 | 4.45 / 4.10 m |
| 助推 | 推力 / 时间 / $I_{sp}$ | 130 kN / 13 s / 215 s |
| 冲压 | 最大推力 / 最大流率 / $I_{sp}$ | 60 kN / 3 kg/s / 1500 s |
| 气动 | $C_N^\alpha$ (M2) / $C_{D0}$ (M2) | 12.89 / 0.312 |
| 舵 | 限幅 / 速率 / 时间常数 | ±25° / 150°/s / 10 ms |
| 导引头 | 视场 / 盲区 / 角度噪声 | ±20° / 120 m / 1 mrad |
| 交接 | 距离 / 速度 / 过载 | 24 km / 1800 m/s / 4 g |
| 仿真 | 步长（助推/中制导） | 5 ms / 10 ms |

## 附录 B 文件索引

- 气动数据：`output/datcom_aero.csv`、`config.py` §5
- 单发结果：`intercept-report/assets/metrics.json`、`output/telemetry.csv`
- 蒙特卡洛：`output/batch/batch_results.csv`
- 性能验证：`output/validation/validation_report.txt`
- 测试：`missile_intercept/tests/`、`python -m pytest -q`

---

## 参考文献

1. NIMA. *Department of Defense World Geodetic System 1984: Its Definition and Relationships with Local Geodetic Systems*. TR8350.2, 3rd ed., 2000.
2. NOAA/NASA/USAF. *U.S. Standard Atmosphere, 1976*. NASA TM-X-74335, 1976.
3. Williams, J. E., Vukelich, S. R. *The USAF Stability and Control Digital DATCOM*. AFFDL-TR-79-3032, 1979.
4. Etkin, B., Reid, L. D. *Dynamics of Flight: Stability and Control*, 3rd ed. Wiley, 1996.
5. Zipfel, P. H. *Modeling and Simulation of Aerospace Vehicle Dynamics*, 3rd ed. AIAA, 2014.
6. Stevens, B. L., Lewis, F. L., Johnson, E. N. *Aircraft Control and Simulation*, 3rd ed. Wiley, 2015.
7. Vallado, D. A. *Fundamentals of Astrodynamics and Applications*, 4th ed. Microcosm, 2013.
8. Zarchan, P. *Tactical and Strategic Missile Guidance*, 6th ed. AIAA, 2012.
9. Bryson, A. E., Ho, Y.-C. *Applied Optimal Control*. Hemisphere, 1975.
10. Yanushevsky, R. *Modern Missile Guidance*, 2nd ed. CRC Press, 2018.
11. Groves, P. D. *Principles of GNSS, Inertial, and Multisensor Integrated Navigation Systems*, 2nd ed. Artech House, 2013.
12. Brown, R. G., Hwang, P. Y. C. *Introduction to Random Signals and Applied Kalman Filtering*, 4th ed. Wiley, 2012.
13. Heiser, W. H., Pratt, D. T. *Hypersonic Airbreathing Propulsion*. AIAA, 1994.
14. Anderson, J. D. *Hypersonic and High-Temperature Gas Dynamics*, 2nd ed. AIAA, 2006.
15. Hoerner, S. F. *Fluid-Dynamic Drag*. Hoerner Fluid Dynamics, 1965.
16. U.S. Department of Defense. *MIL-HDBK-1797: Flying Qualities of Piloted Aircraft*（Dryden 湍流谱与飞行品质），1997.
17. Saltelli, A., et al. *Global Sensitivity Analysis: The Primer*. Wiley, 2008.
18. Skolnik, M. I. *Introduction to Radar Systems*, 3rd ed. McGraw-Hill, 2001（RCS 起伏与角闪烁）.
