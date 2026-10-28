/// <reference types="recooler/vite/client" />
import app from 'virtual:recooler/app';

const response: Response | Promise<Response> = app.fetch(new Request('http://test/'));
void response;
