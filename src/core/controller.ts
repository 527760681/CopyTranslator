import { TranslatorType, translators } from "../tools/translation/translators";
import { CommonTranslateResult, Translator } from "../tools/translation";
import { initConfig } from "../tools/configuration";
import { ConfigParser, getEnumValue } from "../tools/configParser";
import { ColorStatus, MessageType, WinOpt } from "../tools/enums";
import { WindowWrapper } from "../tools/windows";
import { simulatePaste, windowController } from "../tools/windowController";
import { envConfig } from "../tools/envConfig";
import { l10n, L10N } from "../tools/l10n";
import { reverseRuleName, RuleName, colorRules } from "../tools/rule";
import { normalizeAppend } from "./stringProcessor";
import { app, Rectangle } from "electron";
import { ActionManager } from "../tools/action";
import { TrayManager } from "../tools/tray";
import { handleActions } from "./actionCallback";
import { checkNotice } from "../tools/checker";
import { checkForUpdates } from "../tools/update";
import { log } from "../tools/logger";
import { recognizer } from "../tools/ocr";

const clipboard = require("electron-clipboard-extended");
const _ = require("lodash");

class Controller {
  src: string = "";
  result: string = "";
  res: CommonTranslateResult | undefined;
  lastAppend: string = "";
  win: WindowWrapper = new WindowWrapper();
  translator: Translator = new translators.google();
  config: ConfigParser = initConfig();
  locales: L10N = l10n;
  action = new ActionManager(handleActions);
  tray: TrayManager = new TrayManager();
  translating: boolean = false; //正在翻译

  constructor() {
    this.config.loadValues(envConfig.configPath);
    this.restoreFromConfig();
  }

  public static getInstance(): Controller {
    return (<any>global).controller;
  }

  createWindow() {
    this.win.createWindow(this.get(RuleName.frameMode));
    windowController.bind();
    this.tray.init();
    this.action.init();
    recognizer.setUp();
    checkForUpdates();
    checkNotice();
  }
  capture() {
    (<any>global).shortcutCapture.shortcutCapture();
  }
  foldWindow() {
    this.win.edgeHide(this.win.onEdge());
  }
  expandWindow() {
    this.win.edgeShow();
  }

  onExit() {
    this.config.saveValues(envConfig.configPath);
    this.action.unregister();
    app.quit();
  }

  setSrc(append: string) {
    if (this.get(RuleName.incrementalCopy) && this.src != "")
      this.src = this.src + " " + append;
    else this.src = append;
  }

  get(ruleName: RuleName) {
    return this.config.values[getEnumValue(ruleName)];
  }

  resotreDefaultSetting() {
    this.config.restoreDefault(envConfig.configPath);
    this.restoreFromConfig();
  }

  clear() {
    this.src = "";
    this.result = "";
    this.lastAppend = "";
    this.res = undefined;
    this.sync();
  }

  checkClipboard() {
    let text = normalizeAppend(
      clipboard.readText(),
      this.get(RuleName.autoPurify)
    );
    if (this.checkValid(text)) {
      this.doTranslate(text);
    }
  }

  tryTranslate(text: string) {
    if (text != "") {
      this.doTranslate(normalizeAppend(text, this.get(RuleName.autoPurify)));
    }
  }

  getT() {
    return this.locales.getT(this.config.get(RuleName.localeSetting));
  }

  onError(msg: string) {
    log().error(msg);
  }

  sync(language: any = undefined) {
    if (!language) {
      language = {
        source: this.source(),
        target: this.target()
      };
    } else {
      language.source = this.translator.code2lang(language.source);
      language.target = this.translator.code2lang(language.target);
    }
    let extra: any = {};
    if (this.res) {
      extra.phonetic = this.res.phonetic;
      extra.dict = this.res.dict;
    }
    this.win.sendMsg(
      MessageType.TranslateResult.toString(),
      Object.assign(
        {
          src: this.src,
          result: this.result,
          source: language.source,
          target: language.target,
          notify: this.get(RuleName.enableNotify)
        },
        extra
      )
    );
  }
  checkLength(text: string) {
    const threshold = 3000;
    if (text.length > threshold) {
      this.setCurrentColor(true);
      return false;
    } else return true;
  }

  checkValid(text: string) {
    const urlExp = /^(https?:\/\/)?([\da-z.-]+)\.([a-z.]{2,6})([/\w .-]*)*\/?$/;
    if (!this.checkLength(text)) {
      return false;
    }
    return !(
      urlExp.test(text) ||
      this.result == text ||
      this.src == text ||
      this.lastAppend == text ||
      text == ""
    );
  }

  postProcess(language: any, result: CommonTranslateResult) {
    if (this.get(RuleName.autoCopy)) {
      clipboard.writeText(this.result);
      if (this.get(RuleName.autoPaste)) {
        simulatePaste();
      }
    } else if (this.get(RuleName.autoFormat)) {
      clipboard.writeText(this.src);
    }
    this.setCurrentColor();
    if (this.get(RuleName.autoShow)) {
      this.win.edgeShow();
      this.win.show(
        !(this.get(RuleName.autoCopy) && this.get(RuleName.autoPaste))
      );
    }
    this.res = result;
    this.sync(language);
  }

  getOptions() {
    let realOptions = 0;
    colorRules.map(ruleName => {
      if (this.get(ruleName)) {
        realOptions |= ruleName;
      }
    });
    return realOptions;
  }

  setCurrentColor(fail = false) {
    if (fail) {
      this.win.switchColor(ColorStatus.Fail);
      return;
    }
    if (!this.get(RuleName.listenClipboard)) {
      this.win.switchColor(ColorStatus.None);
      return;
    }
    const options = this.getOptions();
    switch (options) {
      case RuleName.incrementalCopy | RuleName.autoCopy | RuleName.autoPaste:
        this.win.switchColor(ColorStatus.IncrementalCopyPaste);
        return;
      case RuleName.incrementalCopy | RuleName.autoCopy:
        this.win.switchColor(ColorStatus.IncrementalCopy);
        return;
      case RuleName.incrementalCopy:
        this.win.switchColor(ColorStatus.Incremental);
        return;
      case RuleName.autoCopy | RuleName.autoPaste:
        this.win.switchColor(ColorStatus.AutoPaste);
        return;
      case RuleName.autoCopy:
        this.win.switchColor(ColorStatus.AutoCopy);
        return;
    }
    this.win.switchColor(ColorStatus.Listen);
  }

  async decideLanguage(text: string) {
    let should_src = this.translator.lang2code(this.source());
    let dest_lang = this.translator.lang2code(this.target());
    let src_lang = should_src;
    try {
      let lang = await this.translator.detect(text);
      if (lang) src_lang = lang;
    } catch (e) {
      this.onError(e);
    }

    if (src_lang == dest_lang) {
      if (this.get(RuleName.smartTranslate)) {
        dest_lang = should_src;
      }
    } else if (!this.get(RuleName.detectLanguage)) {
      src_lang = should_src;
    }

    return {
      source: src_lang,
      target: dest_lang
    };
  }

  preProcess(text: string) {
    this.lastAppend = text;
    this.setSrc(text);
    this.win.switchColor(ColorStatus.Translating);
  }

  setUpRecognizer(APP_ID: string, API_KEY: string, SECRET_KEY: string) {
    this.setByRuleName(RuleName.APP_ID, APP_ID, true, false);
    this.setByRuleName(RuleName.API_KEY, API_KEY, true, false);
    this.setByRuleName(RuleName.SECRET_KEY, SECRET_KEY, true, false);
    recognizer.setUp(true);
  }

  async doTranslate(text: string) {
    if (this.translating || !this.checkLength(text))
      //翻译无法被打断
      return;
    this.translating = true;
    const language = await this.decideLanguage(text);
    if (language.source == language.target) {
      return;
    }
    this.preProcess(text);
    this.translator
      .translate(this.src, language.source, language.target)
      .then(res => {
        if (res && res.resultString) {
          res.resultString = normalizeAppend(
            res.resultString,
            this.get(RuleName.autoPurify)
          );
          this.result = res.resultString;
          this.postProcess(language, res);
        } else {
          this.onError("translate error");
          this.setCurrentColor(true);
        }
        this.translating = false;
      })
      .catch(err => {
        this.translating = false;
        console.error(err);
      });
  }

  source() {
    return this.get(RuleName.sourceLanguage);
  }

  target() {
    return this.get(RuleName.targetLanguage);
  }

  checkImage() {
    recognizer.recognize(clipboard.readImage().toDataURL());
  }

  postProcessImage(words_result: Array<{ words: string }>) {
    let src = _.join(words_result.map(item => item["words"]), "\n");
    this.tryTranslate(src);
  }

  setWatch(watch: boolean) {
    if (watch) {
      clipboard.on("text-changed", () => {
        this.checkClipboard();
      });
      clipboard.on("image-changed", () => {
        this.checkImage();
      });
      clipboard.startWatching();
    } else {
      clipboard.stopWatching();
    }
  }

  saveWindow(routeName: string, bound: Rectangle, fontSize: number) {
    this.setByKeyValue(
      routeName,
      Object.assign(this.config.values[routeName], bound, {
        fontSize: fontSize
      })
    );
  }

  restoreWindow(routeName: string | undefined) {
    if (routeName) this.win.restore(this.config.values[routeName]);
  }

  restoreFromConfig() {
    for (let keyValue in this.config.values) {
      this.setByKeyValue(keyValue, this.config.values[keyValue], false);
    }
  }

  switchValue(ruleKey: string) {
    this.setByKeyValue(ruleKey, !this.config.values[ruleKey]);
  }

  refresh(ruleKey: string | null = null) {
    this.win.winOpt(WinOpt.Refresh, ruleKey);
  }

  setByRuleName(ruleName: RuleName, value: any, save = true, refresh = true) {
    switch (ruleName) {
      case RuleName.listenClipboard:
        this.setWatch(value);
        break;
      case RuleName.stayTop:
        if (this.win.window) {
          this.win.window.focus();
          this.win.window.setAlwaysOnTop(value);
        }
        break;
      case RuleName.incrementalCopy:
        this.clear();
        break;
      case RuleName.autoFormat:
        if (value) {
          this.setByRuleName(RuleName.autoCopy, false, save, refresh);
        }
        break;
      case RuleName.autoCopy:
        if (value) {
          this.setByKeyValue(
            getEnumValue(RuleName.autoFormat),
            false,
            save,
            refresh
          );
        }
        break;
      case RuleName.tapCopy:
        windowController.tapCopy = value;
        break;
      case RuleName.translatorType:
        value = parseInt(value, 10);
        switch (value) {
          case TranslatorType.Google:
            this.translator = new translators.google();
            break;
          case TranslatorType.Baidu:
            this.translator = new translators.baidu();
            break;
          case TranslatorType.Sogou:
            this.translator = new translators.sogou();
            break;
          case TranslatorType.Youdao:
            this.translator = new translators.youdao();
            break;
          case TranslatorType.Caiyun:
            this.translator = new translators.caiyun();
            break;
        }
        this.clear();
        if (!this.translator.isValid(this.get(RuleName.sourceLanguage))) {
          this.setByRuleName(RuleName.sourceLanguage, "English", save, refresh);
        }
        if (!this.translator.isValid(this.get(RuleName.targetLanguage))) {
          this.setByRuleName(
            RuleName.targetLanguage,
            "Chinese(Simplified)",
            save,
            refresh
          );
        }
        this.win.load(this.get(RuleName.frameMode));
        break;
    }

    this.config.set(ruleName, value);
    this.setCurrentColor();
    if (ruleName == RuleName.localeSetting) {
      this.win.sendMsg(MessageType.UpdateT.toString(), null);
    }
    if (save) {
      this.config.saveValues(envConfig.configPath);
      if (refresh) {
        this.refresh();
      } else if (ruleName == RuleName.autoFormat) {
        this.refresh("autoCopy");
      } else if (ruleName == RuleName.autoCopy) {
        this.refresh("autoPurify");
      }
    }
  }

  setByKeyValue(ruleKey: string, value: any, save = true, refresh = true) {
    let ruleValue = reverseRuleName[ruleKey];
    this.setByRuleName(ruleValue, value, save, refresh);
  }
}

export { Controller };
