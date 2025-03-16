---
title: Vulkan接入小总结
date: 2025-03-15 13:23:10
categories: 
	- 技术漫谈
tags: [3D, render, 渲染, 编程, Vulkan]
index_img: /2025/03/15/kong-vulkan-intro/Vulkan_Logo.png
banner_img: /2025/03/15/kong-vulkan-intro/Vulkan_Logo.png
---

# 前言

![一张平平无奇的渲染图](vulkan-scene.png)

这是一张平平无奇的渲染图，没有阴影，没有IBL，也没有反射等各种酷炫高大上的效果。

但这张平平无奇的渲染图是我断断续续花了一个月的时间才完成的结果：**这是KongEngine接入Vulkan后得到的最新效果**。在前面的几篇文章我也提到过，我最近一直在处理这个事，为此我将KongEngine的渲染代码重构，并将Vulkan整合进来。当然原有的OpenGL能力我还是保留着，目前的目标是先利用Vulkan还原原有的OpenGL效果。

这篇文章也不是什么Vulkan入门教程，不会系统的讲Vulkan的初始化流程是怎么样的，Render Pass和Pipeline是什么，DescriptorSet要怎么设定等等。这些内容太复杂了，很难在一篇文章内讲清楚，况且我现在也不能说是很精通。这篇文章只是会大概介绍一下KongEngine目前的Vulkan结构。

# KongEngine的Vulkan结构

如下图所示:

![KongEngine的渲染结构](kong-render-structure.png)

KongEngine目前将图形API的部分整合了起来，封装成了OpenGL部分和Vulkan的部分。目前这两个部分的流程还是有一定的区别，本来按照原有计划是将OpenGL的渲染流程按照Vulkan的流程来实现的，但是发现这样做难度不小，改动很大。放到后面再慢慢整合吧。

为了资源管理的统一，我将Buffer、Texture等通用的概念封装成了基础类，OpenGL和Vulkan会分别实现对应的子类来实现具体的流程。

```c++
enum BufferType : short
{
    VERTEX_BUFFER = 0,
    INDEX_BUFFER,
    UNIFORM_BUFFER,
    NONE_BUFFER,
    
};
class KongBuffer
{
public:
    KongBuffer() = default;
    virtual ~KongBuffer() = default;
    
    virtual void Initialize(BufferType type, uint64_t size, uint32_t instanceCount, void* data = nullptr)
    {
        m_type = type;
        m_isValid = true;
    }
    
    KongBuffer(const KongBuffer& other) = delete;
    KongBuffer& operator=(const KongBuffer& other) = delete;

    virtual void Bind(void* commandBuffer = nullptr) {}    

    bool IsValid() const {return m_isValid;}
protected:
    BufferType m_type {NONE_BUFFER};
    bool m_isValid {false};
};
```

比如说像上面的代码是OpenGL和Vulkan的buffer类的基类，两个图形API会分别继承这个基类实现各自的buffer类：**OpenGLBuffer**和**VulkanBuffer**。这样可以在大体流程不变的情况下针对OpenGL和Vulkan分别做一些特化实现。

```c++
void CQuadShape::InitRenderInfo()
{
    // 屏幕mesh
    std::vector<Vertex> quadVertexArray = {
        {{-1,1, 0}, {0.0, 0.0, 1.0}, {0.0, 1.0}, {1.0, 0.0, 0.0}, {0.0, 0.0, 1.0}},
        {{-1,-1, 0}, {0.0, 0.0, 1.0}, {0.0, 0.0}, {1.0, 0.0, 0.0}, {0.0, 0.0, 1.0}},
        {{1,1, 0}, {0.0, 0.0, 1.0}, {1.0, 1.0}, {1.0, 0.0, 0.0}, {0.0, 0.0, 1.0}},
        {{1,-1, 0}, {0.0, 0.0, 1.0}, {1.0, 0.0}, {1.0, 0.0, 0.0}, {0.0, 0.0, 1.0}},
        {{1,1, 0}, {0.0, 0.0, 1.0}, {1.0, 1.0}, {1.0, 0.0, 0.0}, {0.0, 0.0, 1.0}},
        {{-1,-1, 0}, {0.0, 0.0, 1.0}, {0.0, 0.0}, {1.0, 0.0, 0.0}, {0.0, 0.0, 1.0}},
    };
    
    mesh_resource = make_shared<MeshResource>();
    auto quadMesh = make_shared<CMesh>();
    
#ifndef RENDER_IN_VULKAN
    auto vertex_buffer = make_unique<OpenGLBuffer>();
    vertex_buffer->Initialize(VERTEX_BUFFER, sizeof(Vertex), quadVertexArray.size(), &quadVertexArray[0]);
    std::vector<OpenGLVertexAttribute> vertexAttributes = {
        {3, GL_FLOAT, GL_FALSE, sizeof(Vertex), (void*)offsetof(Vertex, position)},
        {3, GL_FLOAT, GL_FALSE, sizeof(Vertex), (void*)offsetof(Vertex, normal)},
        {2, GL_FLOAT, GL_FALSE, sizeof(Vertex), (void*)offsetof(Vertex, uv)},
        {3, GL_FLOAT, GL_FALSE, sizeof(Vertex), (void*)offsetof(Vertex, tangent)},
        {3, GL_FLOAT, GL_FALSE, sizeof(Vertex), (void*)offsetof(Vertex, bitangent)},
    };
    vertex_buffer->AddAttribute(vertexAttributes);
#else
    auto vertex_buffer = make_unique<VulkanBuffer>();
    vertex_buffer->Initialize(VERTEX_BUFFER, sizeof(Vertex), quadVertexArray.size(), &quadVertexArray[0]);
    
#endif
    
    quadMesh->m_RenderInfo->vertex_buffer = std::move(vertex_buffer);
    quadMesh->m_RenderInfo->vertices = quadVertexArray;
    mesh_resource->mesh_list.push_back(quadMesh);
}
```

上方就是对一个quad形状初始化的代码，OpenGL和Vulkan会使用同样的原始数据，不过由于OpenGLBuffer使用了VAO，所以这里会初始化Attribute布局，而Vulkan这部分逻辑是放在pipeline的，所以这里会有个小差异。

同样这么处理的还有**Texture**、**RenderInfo**等类型。Texture和RenderInfo这两个类型有很多可以细讲的内容，这篇文章就不深入了，会计划单独拿一篇文章来详细介绍（埋个坑）。

# Vulkan的渲染系统

Vulkan目前有三个渲染系统，分别是：**SimpleVulkanRenderSystem、VulkanPostProcessSystem和VulkanSkyBoxRenderSystem**。这三个渲染系统分别对应着PBR、后处理和天空盒。每个Vulkan的渲染系统有着独立的pipeline、renderpass和descriptor set，在创建系统的时候，会按照不同渲染系统的需求来初始化。下面的例子是SimpleVulkanRenderSystem的创建流程。

```c++
SimpleVulkanRenderSystem::SimpleVulkanRenderSystem(VulkanSwapChain* swapChain, KongRenderModule* renderModule)
    :VulkanRenderSystem(swapChain, renderModule)
{
    CreateRenderPass();
    CreateFrameBuffers();
    CreateDescriptorSetLayout();
    CreatePipelineLayout();
    CreatePipeline();
}
```

渲染的时候，每个渲染系统会各自绑定自己的renderpass和pipeline，以及对应的descriptor set输入。目前SimpleVulkanRenderSystem还会使用push constant将modelMatrix传到GPU中（后续这里可能会有修改）。

```c++

void SimpleVulkanRenderSystem::Draw(const FrameInfo& frameInfo)
{
    BeginRenderPass(frameInfo.commandBuffer);
    
    m_pipeline->Bind(frameInfo.commandBuffer);
    
    auto actors = KongSceneManager::GetActors();
    for (auto actor : actors)
    {
        auto mesh_component = actor->GetComponent<CMeshComponent>();
        if (!mesh_component)
        {
            continue;
        }

        auto mesh_shader = mesh_component->shader_data;
        if (dynamic_pointer_cast<DeferInfoShader>(mesh_shader) || dynamic_pointer_cast<DeferredTerrainInfoShader>(mesh_shader))
        {
            continue;
        }
        
        SimplePushConstantData push{};
        push.modelMatrix = actor->GetModelMatrix();

        vkCmdPushConstants(frameInfo.commandBuffer, m_pipelineLayout,
            VK_SHADER_STAGE_VERTEX_BIT | VK_SHADER_STAGE_FRAGMENT_BIT,
            0, sizeof(SimplePushConstantData), &push);
        
        mesh_component->Draw(frameInfo, m_pipelineLayout);
    }

    EndRenderPass(frameInfo.commandBuffer);
}
```

那么整体的更新流程就如下面所示。

```c++
int KongRenderModule::Update(double delta)
{
	mainCamera->Update(delta);
	UpdateSceneRenderInfo();
#ifdef RENDER_IN_VULKAN
	if (auto commandBuffer = GetCurrentCommandBuffer())
	{
		int frameIndex = GetFrameIndex();
		FrameInfo frameInfo{
			frameIndex,
			static_cast<float>(delta),
			commandBuffer
		};

		m_vkSimpleRenderSystem->UpdateMeshUBO(frameInfo);
		
		m_vkSimpleRenderSystem->Draw(frameInfo);
		m_vkSkyboxSystem->Draw(frameInfo);
		m_vkPostProcessSystem->Draw(frameInfo);		
	}
#else
    // ...... OpenGL的流程
#endif
	return 1;
}

```

当然，这里面有很多东西可以讲的，比如说怎么创建对应的Pipeline和renderpass，怎么创建DescriptorSet等等，这些很细节的内容这里就不做介绍了，我会找时间整理一下，看看有没有机会系统的写一篇文章（再埋个坑）。

# 接入ImGui

为了方便，我在处理完几个渲染系统后还将ImGui接入了进来。

接入ImGui其实比我想象中要简单不少，ImGui的官网其实提供了[Vulkan接入ImGui的例子](https://github.com/ocornut/imgui/blob/master/examples/example_glfw_vulkan/main.cpp)，但是一开始看得我云里雾里的。

后面在AI的帮助下，发现和OpenGL的流程其实大差不差。比OpenGL更加复杂的部分就是需要在初始化ImGui的时候传入Vulkan的实例信息。这里我还为ImGui单独创建了一个CommandPool，不太确定是不是必须的，还是可以和模型那边共用。

```c++
void KongUIManager::Init(GLFWwindow* windowHandle)
{
	// 初始化imgui
	IMGUI_CHECKVERSION();
	ImGui::CreateContext();
	ImGuiIO& io = ImGui::GetIO(); (void)io;

	io.ConfigFlags |= ImGuiConfigFlags_NavEnableKeyboard;     // Enable Keyboard Controls
	io.ConfigFlags |= ImGuiConfigFlags_NavEnableGamepad;      // Enable Gamepad Controls
    io.AddMouseButtonEvent(GLFW_MOUSE_BUTTON_LEFT, GLFW_PRESS);
	
	ImGui::StyleColorsDark();

	// 初始化imgui后端
#ifdef RENDER_IN_VULKAN
	
	auto windowModule = KongWindow::GetWindowModule();
	auto vulkanDevice = VulkanGraphicsDevice::GetGraphicsDevice();

	VkDescriptorPoolSize pool_sizes[] =
		{
		{ VK_DESCRIPTOR_TYPE_SAMPLER, 1000 },
		{ VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 1000 },
		{ VK_DESCRIPTOR_TYPE_SAMPLED_IMAGE, 1000 },
		{ VK_DESCRIPTOR_TYPE_STORAGE_IMAGE, 1000 },
		{ VK_DESCRIPTOR_TYPE_UNIFORM_TEXEL_BUFFER, 1000 },
		{ VK_DESCRIPTOR_TYPE_STORAGE_TEXEL_BUFFER, 1000 },
		{ VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, 1000 },
		{ VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1000 },
		{ VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC, 1000 },
		{ VK_DESCRIPTOR_TYPE_STORAGE_BUFFER_DYNAMIC, 1000 },
		{ VK_DESCRIPTOR_TYPE_INPUT_ATTACHMENT, 1000 }
		};

	VkDescriptorPoolCreateInfo pool_info = {};
	pool_info.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO;
	pool_info.flags = VK_DESCRIPTOR_POOL_CREATE_FREE_DESCRIPTOR_SET_BIT;
	pool_info.maxSets = 1000;
	pool_info.poolSizeCount = std::size(pool_sizes);
	pool_info.pPoolSizes = pool_sizes;

	if(vkCreateDescriptorPool(vulkanDevice->GetDevice(), &pool_info, nullptr, &imguiPool) != VK_SUCCESS)
	{
		throw std::runtime_error("failed to create imgui descriptor pool");
	}

	ImGui_ImplGlfw_InitForVulkan(windowHandle, true);   // opengl类似
	ImGui_ImplVulkan_InitInfo init_info{};
	init_info.Instance = vulkanDevice->m_instance;
	init_info.Device = vulkanDevice->m_device;
	init_info.PhysicalDevice = vulkanDevice->m_physicalDevice;
	init_info.QueueFamily = vulkanDevice->FindQueueFamilies(vulkanDevice->m_physicalDevice).graphicsFamily;
	init_info.Queue = vulkanDevice->m_graphicsQueue;
	init_info.PipelineCache = VK_NULL_HANDLE;
	init_info.MinImageCount = 2;
	init_info.ImageCount = 2;
	init_info.MSAASamples = VK_SAMPLE_COUNT_1_BIT;
	init_info.RenderPass = KongRenderModule::GetRenderModule().GetSwapChainRenderPass();
	init_info.Subpass = 0;
	init_info.DescriptorPool = imguiPool;

	ImGui_ImplVulkan_Init(&init_info);                  // opengl类似
	
#else
	ImGui_ImplGlfw_InitForOpenGL(windowHandle, true);          // Second param 
	ImGui_ImplOpenGL3_Init();
#endif
	
    // .......
	
}
```

代码如上面所示。目前最终的渲染代码放在VulkanPostprocessSystem的Draw函数中，EndRenderPass前了，因为后处理使用的是swapchain的render pass。这是临时的处理，后面会放到另外合适的地方。


# shader预处理
VUlkan的shader使用的是SPIR-V(SPV)二进制格式，而不是像OpenGL的glsl，所以在Vulkan中引用shader之前，所有的shader都需要进行编译转换为SPV格式。

```shell
@echo off
setlocal enabledelayedexpansion

set SHADER_DIR=resource\shader

rem 编译顶点着色器
for /R "%SHADER_DIR%" %%f in (*.vulkan.vert) do (
    %VULKAN_SDK%\Bin\glslc.exe "%%f" -o "%%~dpnf.vert.spv" 2>nul
    if !errorlevel! neq 0 (
        echo [ERROR] Failed to compile %%f
        %VULKAN_SDK%\Bin\glslc.exe "%%f" -o "%%~dpnf.vert.spv"
        echo Press any key to continue...
        pause >nul
    ) 
)

rem 编译片段着色器
for /R "%SHADER_DIR%" %%f in (*.vulkan.frag) do (
    %VULKAN_SDK%\Bin\glslc.exe "%%f" -o "%%~dpnf.frag.spv" 2>nul
    if !errorlevel! neq 0 (
        echo [ERROR] Failed to compile %%f
        %VULKAN_SDK%\Bin\glslc.exe "%%f" -o "%%~dpnf.frag.spv"
        echo Press any key to continue...
        pause >nul
    )
)

echo All shaders compiled successfully
pause
```

这里使用的是VULKAN_SDK\BIn路径下的glslc.exe帮助程序来实现编译shader的功能。如果VulkanSDK被正确安装的话，VULKAN_SDK路径会写到system path里面，所以可以直接使用这个脚本。Path里面没有的话，那这个路径一般就是**C:/VulkanSDK/实际的版本号**。可以按需替换。

用glslc很方便的一点就是可以处理shader之间的引用。在OpenGL中除了要在450版本之后，并且在shader中加入**GL_ARB_Shading_language_include**的申明之外。还需要在代码编译shader的时候做一些处理：
```c++
void OpenGLShader::IncludeShader(const string& include_path)
{
	// already include
	if(shader_include_set.find(include_path) != shader_include_set.end())
	{
		return;
	}
	
	// include 文件名需要以“/”开头，要不然会报错，为什么？？
	string full_path = CSceneLoader::ToResourcePath("/shader"+include_path);
	string include_content_str = Utils::ReadFile(full_path);
	
	glNamedStringARB(GL_SHADER_INCLUDE_ARB,
	include_path.size(),
	include_path.c_str(),
	include_content_str.size(),
	include_content_str.c_str());
}

std::vector<std::string> OpenGLShader::FindIncludeFiles(const string& code_content)
{
	std::regex includeRegex("#include \"(.+)\"");  // Regex for #include statements
	std::vector<std::string> includes;  // Vector to store extracted includes

	// Iterate through lines in the code
	std::istringstream iss(code_content);
	std::string line;
	while (std::getline(iss, line)) {
		std::smatch match;
		// For each line, try to match the #include regex
		if (std::regex_search(line, match, includeRegex)) {
			includes.push_back(match[1]);  // Add matched content to includes
		}
	}

	return includes;
}

```
而通过glslc处理的话，就不需要上面的C++逻辑，只需要在shader中开启一些extension，glslc会自动帮我们处理引用，还是非常方便的。

```glsl
#version 450
#extension GL_ARB_separate_shader_objects : enable
#extension GL_EXT_scalar_block_layout : enable

#include "common.glsl"

layout(location=0) in vec3 fragPos;
layout(location=1) in vec3 fragNormal;
layout(location=2) in vec2 fragUV;
layout(location=3) in mat3 TBN;
```

# 结语
好了，不知不觉中已经贴了这么多代码了。今天的这篇文章可能略显无聊，并且都是大段的介绍性文字和代码，读起来可能并不怎么有趣。

确实，这篇文章只是我对学习Vulkan，并将它的能力接入到KongEngine的第一阶段的成果，并不有趣也并没有什么了不起的，但也是一个里程碑，可以记录一下。

现在我慢慢将OpenGL的一些能力接入到Vulkan里面，目前正在做的是延迟渲染的流程。在处理延迟渲染这个流程的时候，我会使用单个Render Pass多Subpass的方法，这是Vulkan相较于OpenGL的一个很重要的区别。

在同一个render pass的多段subpass可以共享附件，不需要等待前一个渲染命令将结果存到内存中，也缓解了GPU的带宽压力；同时subpass的出现可以减少状态切换的开销，也支持并行处理。还有其他很多好处，这里就不一一列举了。

# 参考资料

除了官方的资料外，我这次接入Vulkan很大程度上是依照了这个视频系列[Vulkan(C++) Game Engine Tutorials](https://youtu.be/Y9U9IE0gVHA?si=-JnDZWIx8WiipZi0)。作者深入浅出的将如何实现一个Vulkan渲染引擎的步骤讲解的非常明白，并且将很多图形学上的原理也讲解的十分生动，这里强烈推荐。

