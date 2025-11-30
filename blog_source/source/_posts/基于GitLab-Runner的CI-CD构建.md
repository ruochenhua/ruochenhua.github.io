---
title: 基于GitLab Runner的CI\CD构建
date: 2025-09-30 11:35:53
categories: 
	- 技术漫谈
    - 项目管理
tags: [持续集成, 持续部署, 工具, 项目管理]
---

## 前言
最近在工作中将各个部分的主流程代码都合并了起来，之前各个同事各自埋头苦干的工作汇总到一起后，遇到了不少坑，出现了很多bug，不过好歹最后是将整个流程串起来了。

在主流程合并后，我们的游戏整体也算是初步完成，后续需要维护一个稳定可用的版本来给各位同事去上手尝试，进行整体上的测试、打磨和迭代等等。于是乎，我便在这两天之内，抽空做了下项目的CI\CD流水线。

## 搭建流水线
### 技术选型
UE的持续集成流水线的方案网上应该有不少了，问下豆包、DS等AI都能够给一套比较完整且成熟的方案，比如说Jenkins等等。我们的项目代码是放在GitLab之上，于是就选用了GitLab的原生支持的方案——**GitLab Runner**。

在当前缺乏专用构建机的情况下，我选择以我的开发机器作为构建机，配置GitLab Runner。

### GitLab Runner接入
[GitLab Runner](https://gitlab.com/gitlab-org/gitlab-runner)是GitLab附带的开源持续集成服务，它负责协调测试工作。

想要使用GitLab Runner，首先在[下载安装页面](https://docs.gitlab.com/runner/install/)下载对应版本的文件。我本地开发电脑室Windows，下面的流程都是**基于Windows的流程**。

#### 注册Runner
下载下GitLab Runner后，应该是一个exe文件，版本号可能会有所差异，我们后面都称它为**GitLab-Runner.exe**。

为了使用Runner服务，我们需要做两部准备：1.在我们的Gitlab仓库中，创建一个Runner；2.将我们的构建机和这个Runner关联起来，使得Gitlab有新的构建任务时，会调用到我的机器进行构建。

对于**创建Runner**，我们在GitLab的仓库页面，点击右边栏的**Settings->CI/CD**，进入页面后点击**Runners**，然后再点击**Create Projectile Runner**，便会进入创建该仓库的Runner的页面。在Tags中我们需要配置这个Runner对应的任务类型，这里需要注意因为到时候我们的构建脚本是会需要对应上Runner中的Tags的。

设定完Tags后，点击**Create Runner**后，会加入到一个页面，教我们在构建机上要如何注册Runner。他会给出关键的两个信息：**url**和**token**。需要格外注意的是，这个token在关掉这个页面之后，如果没有完成下面的构建机注册的话，就再也找不到了，有需要的话可以提前复制保存。

我们跳到GitLab-Runner.exe的目录下（如C:\GitLab-Runner），打开命令行，输入：
```powershell
.\gitlab-runner.exe register
```
将会进入注册的流程，我们需要按照提示依次输出：
- url：前面给出
- token：前面给出
- description：这个Runner任务的描述，按照实际情况简单填写。
- job tags：对应Runner的tags
- maintenance note：简单的备注
- executor type：执行器的类型，我们这里是shell，或者pwsh(Powershell)

在一切都顺利执行后，会在前面的Runners界面看到我们新建的Runner，并且名字前面是个绿色圆点的话说明成功激活了。

这里额外提示一点，之前我在处理这块的时候，遇到了网站的证书过期的情况，这样是无论如何都无法通过TLS检验的，哪怕是把tls_verify设置为false也不行。等IT把证书续期之后重新安装证书后才通过，需要留意一下。

#### GitLab Runner的安装
构建机上Runner的安装非常简单，执行下面的指令
```powershell
.\gitlab-runner.exe install
.\gitlab-runner.exe start
```
将会安装并且启动gitlab的服务。

### 流水线脚本
在实现了前面的操作之后，我们可以编写流水线脚本，把每次pipeline触发具体要实现的内容写进去。

我们要在提交项目的根目录下新建一个.gitlab-ci.yml文件，可以看出来它是yaml格式。文件的内容大概分为几个部分：

- stages：将流水线分为几个阶段，每个阶段是一个job，依次运行。
- variables：变量，根据实际使用到的变量来做定义。
- cache：缓存内容。

以及后续各个阶段的具体job内容，下面是一个例子：
```yaml
# 生成项目文件（.sln和.vcxproj）
generate_project_job:
  stage: generate
  needs: [prepare_job]
  script:
    - |
      # 进入项目目录
      cd $CI_PROJECT_DIR
      # 调用UBT生成项目文件（使用变量UBT_PATH）
      & "$UBT_PATH" `
        -ProjectFiles `
        -Project="$($CI_PROJECT_DIR)/$($PROJECT_NAME).uproject" `
        -Game `
        -Engine `
        -Force
  artifacts:
    paths:
      - "$PROJECT_NAME.sln"
      - "*.vcxproj"
      - "*.vcxproj.filters"
    expire_in: 1 day  # 临时保存生成的文件，供后续构建使用
  tags:
    - local
```

这里我们看到，每个job包含对应的stage、这个job的前置条件(needs)、这个job的脚本内容、这个job完成后的上传缓存内容（artifacts）以及这个job对应的tags。更加复杂的还可以添加启用规则（rules）等等。

我们目前流水线分为——准备、生成、构建、打包和存档五个部分。
- 准备：检查环境正确性，创建需要的目录，更新到最新的资源（SVN）
- 生成：利用UBT生成对应的项目，输出sln和vcxproj文件等等
- 构建：结合前面的sln和vcxproj，编译代码，生成对应的dll等等
- 打包：利用UAT烘焙构建，输出打包后的包体内容。
- 存档：将一些关键信息留档

具体的脚本和job内容我这里就不详细说明了，这里说几个我遇到的坑吧：
1. 我们在准备环节的时候是会拉取SVN仓库的，里面有大量的资源需要同步。但是SVN的目录一般git是不会去管理的，这就会导致每次运行一次流水线，GitLab Runner会清理掉未被管理的目录，也就是所有SVN仓库的内容，导致每次都要重新拉取SVN，耗时非常久。所以要在variables中设定GIT_CLEAN_FLAGS，将一些目录排除出去。
2. GitLab Runner的artifacts上传是有大小限制的，免费版本是不允许上传大小超过100M的文件，所以需要注意artifacts的大小否则job会失败。也可以按需设定更大的artifacts上限。

### 定时任务
除了提交触发流水线，我们还可以定时的触发一些任务。

在项目GitLab页面，点击Build->Pipeline Schedules可以打开流水线日程页面，点击**New Schedule**新建定时任务。在新建页面可以选择触发的时间（最好先选择好对应的时区），触发的分支以及一些变量参数等等。

我们目前的设计是在每次提交代码的时候pipeline触发到构建流程，仅仅检查代码错误。每天会定时触发一次完整流程，打包一个版本。

## 结语
好了，这就是简单的介绍一下GitLab流水线的搭建。

在多人团队中，稳定的版本管理还是非常有必要的，没有持续可用的版本会阻塞掉很多同事的工作，尤其是策划同事需要稳定版本来验收功能，测试同事需要可用的版本来测bug等等。同时，稳定版本也能在一定程度上提升代码的质量，及时发现问题，解决问题，不要再最后关头阻塞到一起乱成一锅粥。

