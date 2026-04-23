mDctUart_Data   macro 
 ;//switch cDctUart_Bps 
 ;//    case 9600 
 ;//    lcall       DELAY_103us 
 ;//    break 
 ;//    case 19200 
 ;//    lcall       DELAY_51us 
 ;//    break 
 ;//    case 38400 
     ;//lcall       DELAY_25us  ;25us/25.5/25.75 
     call        DELAY_10us 
     call        DELAY_10us 
     call        DELAY_5us 
 ;//    break 
 ;//endsw 
 endm 

; 测试宏调用
main:
    mDctUart_Data   ; 这里调用宏，应该正常
    goto        main    ; 这里应该报错，因为main标签在下面才定义

; 定义标签
main:
    nop
    ret
