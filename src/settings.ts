import { PluginSettingTab, Setting, type App } from 'obsidian';
import type LearningCoachPlugin from './main';
import { endpoint } from './api';
import type { Settings } from './domain';

export class CoachSettingsTab extends PluginSettingTab {
  constructor(app: App, private readonly coach: LearningCoachPlugin) { super(app, coach); }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('lc-settings');
    new Setting(containerEl).setName('学习设置').setHeading();
    containerEl.createEl('p', { text: '连接你自己的模型服务。只有开始学习或点击测试时才会发送请求；学习时会发送所选笔记片段及相关作答。' });
    new Setting(containerEl).setName('连接模型').setHeading();
    const connection = containerEl.createDiv({ cls: 'lc-connection-status', attr: { role: 'status', 'aria-live': 'polite' } });
    connection.setText('填写下方信息，再测试连接。');
    const save = (patch: Partial<Settings>) => {
      if ('baseUrl' in patch || 'apiKey' in patch || 'model' in patch || 'provider' in patch) { connection.dataset.state = 'idle'; connection.setText('连接信息已更改，请重新测试。'); }
      return this.coach.safely(() => this.coach.saveSettings(patch));
    };
    new Setting(containerEl).setName('接口类型').setDesc('支持 OpenAI 兼容聊天接口，也支持 Ollama 原生接口。')
      .addDropdown(dropdown => dropdown.addOption('compatible', 'OpenAI 兼容接口').addOption('ollama', 'Ollama 原生接口')
        .setValue(this.coach.data.settings.provider).onChange(async value => {
          const oldUrl = this.coach.data.settings.baseUrl;
          const isDefault = ['http://127.0.0.1:11434', 'https://api.openai.com/v1'].includes(oldUrl);
          await save({ provider: value === 'ollama' ? 'ollama' : 'compatible', baseUrl: isDefault ? (value === 'ollama' ? 'http://127.0.0.1:11434' : 'https://api.openai.com/v1') : oldUrl });
          this.display();
        }));
    new Setting(containerEl).setName('服务地址').setDesc('可填服务根地址、/v1 地址或完整的 /chat/completions 地址。自定义网关路径请包含版本前缀。')
      .addText(text => text.setPlaceholder('https://example.com/v1').setValue(this.coach.data.settings.baseUrl).onChange(async value => {
        await save({ baseUrl: value.trim() });
        refreshEndpoint();
      }));
    const endpointEl = containerEl.createEl('p', { cls: 'lc-endpoint' });
    const refreshEndpoint = () => {
      try { endpointEl.setText(`实际请求地址：${endpoint(this.coach.data.settings.baseUrl, this.coach.data.settings.provider)}`); }
      catch (error) { endpointEl.setText(error instanceof Error ? error.message : '地址无效'); }
    };
    refreshEndpoint();
    new Setting(containerEl).setName('访问密钥').setDesc('本地无认证服务可留空。密钥保存在此插件的 data.json 中，未加密；请勿分享该文件。')
      .addText(text => {
        text.inputEl.type = 'password';
        text.inputEl.autocomplete = 'off';
        text.setPlaceholder('填写服务商提供的密钥').setValue(this.coach.data.settings.apiKey).onChange(value => save({ apiKey: value.trim() }));
      });
    new Setting(containerEl).setName('模型名称').setDesc('填写服务商提供的准确模型名称；建议使用能稳定输出结构化内容的聊天模型。')
      .addText(text => text.setPlaceholder('服务商提供的模型名称').setValue(this.coach.data.settings.model).onChange(value => save({ model: value.trim() })));
    new Setting(containerEl).setName('测试连接').setDesc('向当前模型发送一条简短测试消息，可能产生少量调用费用；不发送笔记。')
      .addButton(button => button.setButtonText('测试连接').onClick(async () => {
        button.setDisabled(true).setButtonText('测试中…');
        connection.dataset.state = 'loading'; connection.setText('正在连接模型，请稍候…');
        try { await this.coach.flushSettings(); await this.coach.gateway.test({ ...this.coach.data.settings }); connection.dataset.state = 'success'; connection.setText('连接成功，模型已返回文本。'); }
        catch (error) { connection.dataset.state = 'error'; connection.setText(error instanceof Error ? error.message : '连接失败，请检查配置后重试。'); }
        finally { button.setDisabled(false).setButtonText('测试连接'); }
      }));
    new Setting(containerEl).setName('学习偏好').setHeading();
    new Setting(containerEl).setName('默认带学方式').setDesc('先讲后练适合新知识；先测再学适合检查已有理解。')
      .addDropdown(dropdown => dropdown.addOption('guided', '先讲后练').addOption('diagnostic', '先测再学')
        .setValue(this.coach.data.settings.learningMode).onChange(value => save({ learningMode: value === 'diagnostic' ? 'diagnostic' : 'guided' })));
    new Setting(containerEl).setName('每轮计划题数').setDesc('达到后提示结束本轮，也可以继续加练。结束不等于掌握全部材料。')
      .addDropdown(dropdown => {
        for (const count of [1, 3, 5, 8, 10]) dropdown.addOption(String(count), `${count} 题`);
        dropdown.setValue(String(this.coach.data.settings.questionsPerSession)).onChange(value => save({ questionsPerSession: Number(value) }));
      });
    new Setting(containerEl).setName('结束后自动保存总结').setDesc('写入学习记录目录。同一轮不会自动覆盖已存在的总结。')
      .addToggle(toggle => toggle.setValue(this.coach.data.settings.autoExport).onChange(value => save({ autoExport: value })));
    new Setting(containerEl).setName('学习记录目录').setDesc('导出笔记时使用的库内目录，源笔记保持独立。')
      .addText(text => text.setValue(this.coach.data.settings.outputFolder).onChange(value => save({ outputFolder: value })));
    const advanced = containerEl.createEl('details', { cls: 'lc-settings-advanced lc-disclosure' });
    advanced.createEl('summary', { text: '高级设置' });
    new Setting(advanced).setName('请求超时').setDesc('每次模型请求最多等待多少秒。暂停会忽略迟到结果，已发出的服务端请求可能仍在处理。')
      .addDropdown(dropdown => {
        for (const seconds of [30, 60, 90, 120, 180, 300]) dropdown.addOption(String(seconds), `${seconds} 秒`);
        dropdown.setValue(String(this.coach.data.settings.timeoutSeconds)).onChange(value => save({ timeoutSeconds: Number(value) }));
      });
    new Setting(advanced).setName('每次学习调用上限').setDesc('包括提示、讲解、复核和重试，达到上限后暂停新的调用。')
      .addDropdown(dropdown => {
        for (const calls of [10, 20, 30, 50, 100]) dropdown.addOption(String(calls), `${calls} 次`);
        dropdown.setValue(String(this.coach.data.settings.maxCalls)).onChange(value => save({ maxCalls: Number(value) }));
      });
    new Setting(advanced).setName('生成温度').setDesc('较低的值通常更适合稳定的带学结构。')
      .addSlider(slider => slider.setLimits(0, 1, 0.1).setValue(this.coach.data.settings.temperature)
        .onChange(value => save({ temperature: value })));
    new Setting(advanced).setName('发送生成温度参数').setDesc('如果服务商提示不支持生成温度参数，请关闭此选项。本地原生接口使用服务自身的配置。')
      .addToggle(toggle => toggle.setValue(this.coach.data.settings.sendTemperature).onChange(value => save({ sendTemperature: value })));
  }
}
