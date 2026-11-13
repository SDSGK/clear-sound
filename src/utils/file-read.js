/**
 * file-read.js —— File/Blob 内容读取兜底
 *
 * 背景:跨 App 拖拽进来的 File 对象可能是残缺实现(原型上没有 arrayBuffer 方法,
 * 或延迟读取时句柄失效抛 InvalidStateError)。因此:
 *  1) 优先标准 Blob.arrayBuffer();
 *  2) 缺失或失败时降级 FileReader.readAsArrayBuffer(兼容性最好的老 API);
 *  3) 仍失败则抛出带原因的 Error。
 *
 * @param {File|Blob} file 文件对象
 * @returns {Promise<ArrayBuffer>} 文件内容
 */
export function readAsArrayBuffer(file) {
  if (file && typeof file.arrayBuffer === 'function') {
    return file.arrayBuffer()
  }
  if (typeof FileReader === 'undefined') {
    return Promise.reject(new Error('FILE_READ_UNSUPPORTED'))
  }
  return new Promise((resolve, reject) => {
    try {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = () => reject((reader.error && reader.error.message) || new Error('FILE_READ_FAILED'))
      reader.readAsArrayBuffer(file)
    } catch (err) {
      reject(err && err.message ? err.message : String(err))
    }
  })
}

export default readAsArrayBuffer
