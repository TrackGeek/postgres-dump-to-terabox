declare module "terabox-upload-tool" {
  export interface TeraboxCredentialsInput {
    ndus: string;
    appId: string;
    jsToken: string;
    bdstoken?: string;
    browserId?: string;
  }

  export interface TeraboxFileEntry {
    fs_id: number;
    path: string;
    server_filename: string;
    server_mtime: number;
    server_ctime?: number;
    local_mtime?: number;
    size: number;
    isdir: number;
  }

  export interface TeraboxListResponse {
    errno: number;
    errmsg?: string;
    list?: TeraboxFileEntry[];
  }

  export interface TeraboxResult<T> {
    success: boolean;
    message: string;
    data?: T;
    result?: T;
  }

  export default class TeraboxUploader {
    constructor(credentials: TeraboxCredentialsInput);
    createDirectory(directoryPath: string): Promise<TeraboxResult<{ errno: number; errmsg?: string }>>;
    fetchFileList(directory?: string): Promise<TeraboxResult<TeraboxListResponse>>;
    deleteFiles(fileList: string[]): Promise<TeraboxResult<{ errno: number; errmsg?: string; taskid?: number }>>;
  }
}
