// Copyright (c) 2018 ml5
//
// This software is released under the MIT License.
// https://opensource.org/licenses/MIT

/*
A class that extract features from Mobilenet
*/

import * as tf from '@tensorflow/tfjs';

import Video from './../utils/Video';

import { imgToTensor } from '../utils/imageUtilities';
import { saveBlob } from '../utils/io';
import callCallback from '../utils/callcallback';

const IMAGE_SIZE = 224;
const BASE_URL = 'https://storage.googleapis.com/tfjs-models/tfjs/mobilenet_v';
const DEFAULTS = {
  version: 1,
  alpha: 0.25,
  topk: 3,
  learningRate: 0.0001,
  hiddenUnits: 100,
  epochs: 20,
  numClasses: 2,
  batchSize: 0.4,
  layer: 'conv_pw_13_relu',
};
const MODEL_INFO = {
  1: {
    0.25:
        'https://tfhub.dev/google/imagenet/mobilenet_v1_025_224/classification/1',
    0.50:
        'https://tfhub.dev/google/imagenet/mobilenet_v1_050_224/classification/1',
    0.75:
        'https://tfhub.dev/google/imagenet/mobilenet_v1_075_224/classification/1',
    1.00:
        'https://tfhub.dev/google/imagenet/mobilenet_v1_100_224/classification/1'
  },
  2: {
    0.50:
        'https://tfhub.dev/google/imagenet/mobilenet_v2_050_224/classification/2',
    0.75:
        'https://tfhub.dev/google/imagenet/mobilenet_v2_075_224/classification/2',
    1.00:
        'https://tfhub.dev/google/imagenet/mobilenet_v2_100_224/classification/2'
  }
};

const EMBEDDING_NODES = {
  1: 'module_apply_default/MobilenetV1/Logits/global_pool',
  2: 'module_apply_default/MobilenetV2/Logits/AvgPool'
};

class Mobilenet {
  constructor(options, callback) {
    this.mobilenet = null;
    this.topKPredictions = 10;
    this.hasAnyTrainedClass = false;
    this.customModel = null;
    this.epochs = options.epochs || DEFAULTS.epochs;
    this.version = options.version || DEFAULTS.version;
    this.hiddenUnits = options.hiddenUnits || DEFAULTS.hiddenUnits;
    this.numClasses = options.numClasses || DEFAULTS.numClasses;
    this.learningRate = options.learningRate || DEFAULTS.learningRate;
    this.batchSize = options.batchSize || DEFAULTS.batchSize;
    this.layer = options.layer || DEFAULTS.layer;
    this.alpha = options.alpha || DEFAULTS.alpha;
    this.isPredicting = false;
    this.mapStringToIndex = [];
    this.usageType = null;
    this.ready = callCallback(this.loadModel(), callback);

    // for graph model
    this.model = null;
    this.url = MODEL_INFO[this.version][this.alpha];
    this.normalizationOffset = tf.scalar(127.5);
  }

  async loadModel() {
    this.mobilenet = await tf.loadLayersModel(`${BASE_URL}${this.version}_${this.alpha}_${IMAGE_SIZE}/model.json`);
    this.model = await tf.loadGraphModel(this.url, {fromTFHub: true});


    const layer = this.mobilenet.getLayer(this.layer);
    this.mobilenetFeatures = await tf.model({ inputs: this.mobilenet.inputs, outputs: layer.output });
    // if (this.video) {
    //   await this.mobilenet.classify(imgToTensor(this.video)); // Warm up
    // }
    return this;
  }

  classification(video, callback) {
    this.usageType = 'classifier';
    if (video) {
      callCallback(this.loadVideo(video), callback);
    }
    return this;
  }

  regression(video, callback) {
    this.usageType = 'regressor';
    if (video) {
      callCallback(this.loadVideo(video), callback);
    }
    return this;
  }

  async loadVideo(video) {
    let inputVideo = null;

    if (video instanceof HTMLVideoElement) {
      inputVideo = video;
    } else if (typeof video === 'object' && video.elt instanceof HTMLVideoElement) {
      inputVideo = video.elt; // p5.js video element
    }

    if (inputVideo) {
      const vid = new Video(inputVideo, IMAGE_SIZE);
      this.video = await vid.loadVideo();
    }

    return this;
  }

  async addImage(inputOrLabel, labelOrCallback, cb) {
    let imgToAdd;
    let label;
    let callback = cb;

    if (inputOrLabel instanceof HTMLImageElement || inputOrLabel instanceof HTMLVideoElement || inputOrLabel instanceof HTMLCanvasElement) {
      imgToAdd = inputOrLabel;
    } else if (typeof inputOrLabel === 'object' &&
      (inputOrLabel.elt instanceof HTMLImageElement || inputOrLabel.elt instanceof HTMLVideoElement || inputOrLabel.elt instanceof HTMLCanvasElement)) {
      imgToAdd = inputOrLabel.elt;
    } else if (typeof inputOrLabel === 'string' || typeof inputOrLabel === 'number') {
      imgToAdd = this.video;
      label = inputOrLabel;
    }

    if (typeof labelOrCallback === 'string' || typeof labelOrCallback === 'number') {
      label = labelOrCallback;
    } else if (typeof labelOrCallback === 'function') {
      callback = labelOrCallback;
    }

    if (typeof label === 'string') {
      if (!this.mapStringToIndex.includes(label)) {
        label = this.mapStringToIndex.push(label) - 1;
      } else {
        label = this.mapStringToIndex.indexOf(label);
      }
    }

    return callCallback(this.addImageInternal(imgToAdd, label), callback);
  }

  async addImageInternal(imgToAdd, label) {
    await this.ready;
    tf.tidy(() => {
      const imageResize = (imgToAdd === this.video) ? null : [IMAGE_SIZE, IMAGE_SIZE];
      const processedImg = imgToTensor(imgToAdd, imageResize);
      const prediction = this.mobilenetFeatures.predict(processedImg);
      let y;
      if (this.usageType === 'classifier') {
        y = tf.tidy(() => tf.oneHot(tf.tensor1d([label], 'int32'), this.numClasses));
      } else if (this.usageType === 'regressor') {
        y = tf.tensor2d([[label]]);
      }

      if (this.xs == null) {
        this.xs = tf.keep(prediction);
        this.ys = tf.keep(y);
        this.hasAnyTrainedClass = true;
      } else {
        const oldX = this.xs;
        this.xs = tf.keep(oldX.concat(prediction, 0));
        const oldY = this.ys;
        this.ys = tf.keep(oldY.concat(y, 0));
        oldX.dispose();
        oldY.dispose();
        y.dispose();
      }
    });
    return this;
  }

  async train(onProgress) {
    if (!this.hasAnyTrainedClass) {
      throw new Error('Add some examples before training!');
    }

    this.isPredicting = false;

    if (this.usageType === 'classifier') {
      this.loss = 'categoricalCrossentropy';
      this.customModel = tf.sequential({
        layers: [
          tf.layers.flatten({ inputShape: [7, 7, 256] }),
          tf.layers.dense({
            units: this.hiddenUnits,
            activation: 'relu',
            kernelInitializer: 'varianceScaling',
            useBias: true,
          }),
          tf.layers.dense({
            units: this.numClasses,
            kernelInitializer: 'varianceScaling',
            useBias: false,
            activation: 'softmax',
          }),
        ],
      });
    } else if (this.usageType === 'regressor') {
      this.loss = 'meanSquaredError';
      this.customModel = tf.sequential({
        layers: [
          tf.layers.flatten({ inputShape: [7, 7, 256] }),
          tf.layers.dense({
            units: this.hiddenUnits,
            activation: 'relu',
            kernelInitializer: 'varianceScaling',
            useBias: true,
          }),
          tf.layers.dense({
            units: 1,
            useBias: false,
            kernelInitializer: 'Zeros',
            activation: 'linear',
          }),
        ],
      });
    }

    const optimizer = tf.train.adam(this.learningRate);
    this.customModel.compile({ optimizer, loss: this.loss });
    const batchSize = Math.floor(this.xs.shape[0] * this.batchSize);
    if (!(batchSize > 0)) {
      throw new Error('Batch size is 0 or NaN. Please choose a non-zero fraction.');
    }

    return this.customModel.fit(this.xs, this.ys, {
      batchSize,
      epochs: this.epochs,
      callbacks: {
        onBatchEnd: async (batch, logs) => {
          onProgress(logs.loss.toFixed(5));
          await tf.nextFrame();
        },
        onTrainEnd: () => onProgress(null),
      },
    });
  }

  /* eslint max-len: ["error", { "code": 180 }] */
  async classify(inputOrCallback, cb) {
    let imgToPredict;
    let callback;

    if (inputOrCallback instanceof HTMLImageElement || inputOrCallback instanceof HTMLVideoElement || inputOrCallback instanceof HTMLCanvasElement) {
      imgToPredict = inputOrCallback;
    } else if (typeof inputOrCallback === 'object' &&
      (inputOrCallback.elt instanceof HTMLImageElement || inputOrCallback.elt instanceof HTMLVideoElement || inputOrCallback.elt instanceof HTMLCanvasElement)) {
      imgToPredict = inputOrCallback.elt; // p5.js image element
    } else if (typeof inputOrCallback === 'function') {
      imgToPredict = this.video;
      callback = inputOrCallback;
    }

    if (typeof cb === 'function') {
      callback = cb;
    }

    return callCallback(this.classifyInternal(imgToPredict), callback);
  }

  async classifyInternal(imgToPredict) {
    if (this.usageType !== 'classifier') {
      throw new Error('Mobilenet Feature Extraction has not been set to be a classifier.');
    }
    await tf.nextFrame();
    this.isPredicting = true;
    const predictedClasses = tf.tidy(() => {
      const imageResize = (imgToPredict === this.video) ? null : [IMAGE_SIZE, IMAGE_SIZE];
      const processedImg = imgToTensor(imgToPredict, imageResize);
      const activation = this.mobilenetFeatures.predict(processedImg);
      const predictions = this.customModel.predict(activation);
      return Array.from(predictions.as1D().dataSync());
    });
    const results = await predictedClasses.map((confidence, index) => {
      const label = (this.mapStringToIndex.length > 0 && this.mapStringToIndex[index]) ? this.mapStringToIndex[index] : index;
      return {
        label,
        confidence,
      };
    }).sort((a, b) => b.confidence - a.confidence);
    return results;
  }

  /* eslint max-len: ["error", { "code": 180 }] */
  async predict(inputOrCallback, cb) {
    let imgToPredict;
    let callback;
    if (inputOrCallback instanceof HTMLImageElement || inputOrCallback instanceof HTMLVideoElement || inputOrCallback instanceof HTMLCanvasElement) {
      imgToPredict = inputOrCallback;
    } else if (typeof inputOrCallback === 'object' &&
      (inputOrCallback.elt instanceof HTMLImageElement || inputOrCallback.elt instanceof HTMLVideoElement || inputOrCallback.elt instanceof HTMLCanvasElement)) {
      imgToPredict = inputOrCallback.elt; // p5.js image element
    } else if (typeof inputOrCallback === 'function') {
      imgToPredict = this.video;
      callback = inputOrCallback;
    }

    if (typeof cb === 'function') {
      callback = cb;
    }
    return callCallback(this.predictInternal(imgToPredict), callback);
  }

  async predictInternal(imgToPredict) {
    if (this.usageType !== 'regressor') {
      throw new Error('Mobilenet Feature Extraction has not been set to be a regressor.');
    }
    await tf.nextFrame();
    this.isPredicting = true;
    const predictedClass = tf.tidy(() => {
      const imageResize = (imgToPredict === this.video) ? null : [IMAGE_SIZE, IMAGE_SIZE];
      const processedImg = imgToTensor(imgToPredict, imageResize);
      const activation = this.mobilenetFeatures.predict(processedImg);
      const predictions = this.customModel.predict(activation);
      return predictions.as1D();
    });
    const prediction = await predictedClass.data();
    predictedClass.dispose();
    return { value: prediction[0] };
  }

  async load(filesOrPath = null, callback) {
    if (typeof filesOrPath !== 'string') {
      let model = null;
      let weights = null;
      Array.from(filesOrPath).forEach((file) => {
        if (file.name.includes('.json')) {
          model = file;
          const fr = new FileReader();
          fr.onload = (d) => {
            this.mapStringToIndex = JSON.parse(d.target.result).ml5Specs.mapStringToIndex;
          };
          fr.readAsText(file);
        } else if (file.name.includes('.bin')) {
          weights = file;
        }
      });
      this.customModel = await tf.loadLayersModel(tf.io.browserFiles([model, weights]));
    } else {
      fetch(filesOrPath)
        .then(r => r.json())
        .then((r) => { this.mapStringToIndex = r.ml5Specs.mapStringToIndex; });
      this.customModel = await tf.loadLayersModel(filesOrPath);
      if (callback) {
        callback();
      }
    }
    return this.customModel;
  }

  async save(callback, name) {
    if (!this.customModel) {
      throw new Error('No model found.');
    }
    this.customModel.save(tf.io.withSaveHandler(async (data) => {
      let modelName = 'model';
      if(name) modelName = name;

      this.weightsManifest = {
        modelTopology: data.modelTopology,
        weightsManifest: [{
          paths: [`./${modelName}.weights.bin`],
          weights: data.weightSpecs,
        }],
        ml5Specs: {
          mapStringToIndex: this.mapStringToIndex,
        },
      };
      await saveBlob(data.weightData, `${modelName}.weights.bin`, 'application/octet-stream');
      await saveBlob(JSON.stringify(this.weightsManifest), `${modelName}.json`, 'text/plain');
      if (callback) {
        callback();
      }
    }));
  }

  mobilenetInfer(input, embedding=false) {
    let img = input;
    if (img instanceof tf.Tensor || img instanceof ImageData || 
        img instanceof HTMLImageElement || img instanceof HTMLCanvasElement 
        || img instanceof HTMLVideoElement ) {
          return tf.tidy(() => {
              if (!(img instanceof tf.Tensor)) {
                  img = tf.browser.fromPixels(img);
                }
              const normalized = img.toFloat().sub(this.normalizationOffset)
                                    .div(this.normalizationOffset);

              // Resize the image to
              let resized = normalized;
              if (img.shape[0] !== IMAGE_SIZE || img.shape[1] !== IMAGE_SIZE) {
                const alignCorners = true;
                resized = tf.image.resizeBilinear(
                    normalized, [IMAGE_SIZE, IMAGE_SIZE], alignCorners);
              }

              // Reshape so we can pass it to predict.
              const batched = resized.reshape([-1, IMAGE_SIZE, IMAGE_SIZE, 3]);
              let result;
              if (embedding) {
                const embeddingName = EMBEDDING_NODES[this.version];
                const internal = this.model.execute(batched, embeddingName);
                result = internal.squeeze([1, 2]);
              } else {
                const logits1001 = this.model.predict(batched);
                result = logits1001.slice([0, 1], [-1, 1000]);
              }
              return result;
            }
          );
        }
      return null;
  }

  infer(input, endpoint) {
    let imgToPredict;
    let endpointToPredict;
    if (input instanceof HTMLImageElement || input instanceof HTMLVideoElement || input instanceof HTMLCanvasElement || input instanceof ImageData) {
      imgToPredict = input;
    } else if (typeof input === 'object' && (input.elt instanceof HTMLImageElement || input.elt instanceof HTMLVideoElement || input.elt instanceof HTMLCanvasElement)) {
      imgToPredict = input.elt; // p5.js image/canvas/video element
    } else {
      throw new Error('No input image found.');
    }
    if (endpoint && typeof endpoint === 'string') {
      endpointToPredict = endpoint;
    } else {
      endpointToPredict = 'conv_preds';
    }
    return this.mobilenetInfer(imgToPredict, endpointToPredict);
  }
}

export default Mobilenet;