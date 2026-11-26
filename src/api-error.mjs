const errors = {
  BAD_REQUEST:[400,'請求格式不符'], CONTEXT_LIMIT:[400,'請求超出模型 Context 上限'],
  UNAUTHENTICATED:[401,'需要有效的 API Token'], SCOPE_REQUIRED:[403,'Token 權限不足'],
  ORIGIN_DENIED:[403,'只接受 IPv4 本機同源請求'], INFERENCE_DISABLED:[403,'推論尚未取得資格'],
  NOT_FOUND:[404,'查無接口或工作'], MODEL_UNAVAILABLE:[404,'查無已啟用的模型'],
  METHOD_NOT_ALLOWED:[405,'此接口不接受指定方法'], CONTENT_TYPE:[415,'需要 UTF-8 JSON'],
  BODY_LIMIT:[413,'請求內容超出上限'], RATE_LIMIT:[429,'超出請求頻率上限'],
  BUSY:[429,'並行作業達上限'], QUEUE_FULL:[429,'工作佇列已滿'], CONFLICT:[409,'工作狀態不允許此操作'],
  REQUEST_CONFLICT:[409,'相同請求識別綁定不同內容'], WORKER_UNAVAILABLE:[503,'沒有合格的執行節點'],
  TOKEN_REGISTRY_UNAVAILABLE:[503,'Token 登錄或安裝設定需要重新驗證'],
  READ_TIMEOUT:[504,'等待工作超過上限，請查詢已建立的工作'],
  JOB_FAILED:[502,'工作未完成，請查詢工作狀態'], RESPONSE_LIMIT:[502,'回應內容超出上限'],
  JOB_CANCELLED:[409,'工作已取消'], JOB_INTERRUPTED:[503,'工作狀態仍待核對，請查詢原工作'],
  STREAM_MISMATCH:[502,'暫定串流與已核對終態不一致'], CLIENT_DISCONNECTED:[499,'客戶端已中斷等待'],
  TELEMETRY_REJECTED:[400,'遙測格式或驗證不符'], TELEMETRY_SCOPE_DENIED:[403,'遙測身分不符'],
  TELEMETRY_BUSY:[429,'遙測接收暫時無法使用'],
  STORAGE_UNAVAILABLE:[503,'工作資料目前沒有通過核對'], INTERNAL:[500,'作業失敗']
};

export function fail(code) {
  const known=Object.hasOwn(errors,code)?code:'INTERNAL';
  const [status,message]=errors[known];
  return Object.assign(Error(message),{status,code:known});
}

export function publicError(cause) {
  if (['TimeoutError','AbortError'].includes(cause?.name)) return fail('READ_TIMEOUT');
  if (Object.hasOwn(errors,cause?.code) && cause.status===errors[cause.code][0]) return fail(cause.code);
  const aliases={
    JOB_NOT_FOUND:'NOT_FOUND', REQUEST_ID_CONFLICT:'REQUEST_CONFLICT',
    IDEMPOTENCY_CONFLICT:'REQUEST_CONFLICT', NODE_UNAVAILABLE:'WORKER_UNAVAILABLE',
    JOB_NOT_CANCELLABLE:'CONFLICT', MODEL_NOT_FOUND:'MODEL_UNAVAILABLE', INVALID_REQUEST:'BAD_REQUEST',
    MODEL_LIMIT_EXCEEDED:'CONTEXT_LIMIT', MODEL_UNAVAILABLE:'WORKER_UNAVAILABLE', CONTROLLER_BUSY:'CONFLICT',
    DURABLE_STATE_INVALID:'STORAGE_UNAVAILABLE', STORAGE_UNSAFE:'STORAGE_UNAVAILABLE',
    STORAGE_FORMAT_UNSUPPORTED:'STORAGE_UNAVAILABLE', CONTROLLER_CLOSED:'STORAGE_UNAVAILABLE'
  };
  const code=Object.hasOwn(aliases,cause?.code)?aliases[cause.code]:cause?.code;
  return fail(Object.hasOwn(errors,code)?code:'INTERNAL');
}
