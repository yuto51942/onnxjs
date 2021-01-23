// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.

import {Logger, Profiler} from '../../instrument';
import {Tensor} from '../../tensor';

import {Encoder} from './texture-data-encoder';
import {TextureLayoutStrategy} from './texture-layout-strategy';
import {TextureData, TextureLayout} from './types';
import {WebGLContext} from './webgl-context';

export interface TextureManagerConfig {
  reuseTextures?: boolean;
}

/**
 * TextureManager is the mainly responsible for caching Textures
 * Textures are cached in 2 levels:
 *   1. the texures which are associated with a dataId (from Tensor)
 *    Caching these is crucial to performance. These are In-use Textures
 *   2. textures which are not in use by any current ProgramInfo/Tensor
 *     These are called Free Textures
 * TextureManager is also used to help creating textures. For this it
 * uses WebGLContext and TextureLayoutStrategy
 */
export class TextureManager {
  private readonly inUseTextures: Map<string, WebGLTexture[]>;
  private readonly idleTextures: Map<string, WebGLTexture[]>;
  private readonly textureLookup: Map<WebGLTexture, string>;

  constructor(
      public glContext: WebGLContext, public layoutStrategy: TextureLayoutStrategy, public profiler: Readonly<Profiler>,
      private config: TextureManagerConfig) {
    if (config.reuseTextures) {
      this.inUseTextures = new Map();
      this.idleTextures = new Map();
      this.textureLookup = new Map();
    }
  }
  createTextureFromLayout(
      dataType: Tensor.DataType, layout: TextureLayout, data?: Tensor.NumberType, usage?: Encoder.Usage) {
    const textureDataType = this.toEncoderType(dataType);

    const encoder = this.glContext.getEncoder(textureDataType, layout.channels || 1, usage);
    if (layout.isPacked && usage === Encoder.Usage.UploadOnly) {
      throw new Error('not implemented');
    }
    let width = layout.width;
    let height = layout.height;

    let key: string|undefined;
    let inUseTextures: WebGLTexture[]|undefined;
    if (this.config.reuseTextures) {
      key = `${width}x${height}_${encoder.format}_${encoder.internalFormat}_${encoder.textureType}`;
      inUseTextures = this.inUseTextures.get(key);
      if (!inUseTextures) {
        inUseTextures = [];
        this.inUseTextures.set(key, inUseTextures);
      }

      const idleTextures = this.idleTextures.get(key);
      if (idleTextures && idleTextures.length > 0) {
        const texture = idleTextures.pop()!;
        inUseTextures.push(texture);
        if (usage === Encoder.Usage.UploadOnly) {
          this.glContext.updateTexture(texture, width, height, encoder, this.toTextureData(dataType, data)!);
        }
        return texture;
      }
    }

    Logger.verbose('TextureManager', `Creating new texture of size ${layout.width}x${layout.height}`);
    const texture = this.glContext.allocateTexture(width, height, encoder, this.toTextureData(dataType, data));

    if (this.config.reuseTextures) {
      inUseTextures!.push(texture);
      this.textureLookup.set(texture, key!);
    }
    return texture;
  }
  readTexture(td: TextureData, dataType: Tensor.DataType, channels?: number): Tensor.NumberType {
    if (!channels) {
      channels = 1;
    }
    return this.profiler.event('backend', 'TextureManager.readTexture', () => {
      const dataSize = td.shape.reduce((a, b) => a * b) * channels!;
      const data = this.glContext.readTexture(
          td.texture, td.width, td.height, dataSize, this.toEncoderType(dataType), channels!);
      return this.toTensorData(dataType, data);
    });
  }
  readUint8TextureAsFloat(td: TextureData): Float32Array {
    return this.profiler.event('backend', 'TextureManager.readUint8TextureAsFloat', () => {
      const dataSize = td.shape.reduce((a, b) => a * b);
      const data = this.glContext.readTexture(td.texture, td.width, td.height, dataSize * 4, 'byte', 4);
      return new Float32Array(data.buffer, data.byteOffset, dataSize);
    });
  }
  releaseTexture(textureData: TextureData, deleteTexture?: boolean): void {
    let key: string|undefined;
    if (this.config.reuseTextures) {
      key = this.textureLookup.get(textureData.texture);
      if (key) {
        if (deleteTexture) {
          this.textureLookup.delete(key);
        }
        const inUseTextures = this.inUseTextures.get(key);
        if (inUseTextures) {
          const index = inUseTextures.indexOf(textureData.texture);
          if (index !== -1) {
            inUseTextures.splice(index, 1);
            let idleTextures = this.idleTextures.get(key);
            if (!idleTextures) {
              idleTextures = [];
              this.idleTextures.set(key, idleTextures);
            }
            idleTextures.push(textureData.texture);
          }
        }
      }
    }

    if (!key || deleteTexture) {
      Logger.verbose('TextureManager', `Deleting texture of size ${textureData.width}x${textureData.height}`);
      this.glContext.deleteTexture(textureData.texture);
    }
  }
  toTensorData(dataType: Tensor.DataType, data: Encoder.DataArrayType): Tensor.NumberType {
    return (data instanceof Float32Array) ? data : new Float32Array(data);
    /*
    switch (dataType) {
      case 'int16':
        return new Int16Array(data);
      case 'int32':
        return new Int32Array(data);
      case 'int8':
        return new Int8Array(data);
      case 'uint16':
        return new Uint16Array(data);
      case 'uint32':
        return data as Uint32Array;
      case 'uint8':
      case 'bool':
        return data as Uint8Array;
      case 'float32':
        return data as Float32Array;
      case 'float64':
        return new Float64Array(data);
      default:
        throw new Error(`TensorData type ${dataType} is not supported`);
    }
    */
  }
  toTextureData(dataType: Tensor.DataType, data: Tensor.NumberType|undefined): Encoder.DataArrayType|undefined {
    if (!data) {
      return undefined;
    }
    return (data instanceof Float32Array) ? data : new Float32Array(data);
    /*
    switch (dataType) {
      case 'int16':
      case 'int32':
      case 'uint16':
      case 'uint32':
        return (data.constructor === Uint32Array) ? data as Uint32Array : new Uint32Array(data);
      case 'int8':
      case 'uint8':
      case 'bool':
        return (data.constructor === Uint8Array) ? data as Uint8Array : new Uint8Array(data);
      case 'float32':
      case 'float64':
        return (data.constructor === Float32Array) ? data as Float32Array : new Float32Array(data);
      default:
        throw new Error(`TensorData type ${dataType} is not supported`);
    }
    */
  }
  toEncoderType(dataType: Tensor.DataType): Encoder.DataType {
    return 'float';
    // switch (dataType) {
    //   case 'int16':
    //   case 'int32':
    //   case 'uint16':
    //   case 'uint32':
    //     return 'int';
    //   case 'uint8':
    //   case 'bool':
    //     return 'byte';
    //   case 'float32':
    //   case 'float64':
    //     return 'float';
    //   default:
    //     throw new Error(`TensorData type ${dataType} is not supported`);
    // }
  }
  clearActiveTextures(): void {
    this.glContext.clearActiveTextures();
  }
}
